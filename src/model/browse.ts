import type { Page } from 'playwright';
import type Anthropic from '@anthropic-ai/sdk';
import type { BrowserRuntime, IsolatedContext } from '../browser/runtime.js';
import { gotoWithPolicy } from '../browser/runtime.js';
import { collectPageSnapshot, type PageSnapshot } from '../browser/collect.js';
import { evaluateInPage } from '../browser/evaluate.js';
import { buildInventory, settle } from '../browser/inspect.js';
import { preferredLocator, toLocator } from '../browser/locators.js';
import { AUTH_PATTERN, isConsentLike } from '../browser/classify.js';
import { NEVER_FILL_TYPES } from '../html/forms.js';
import type { ElementRecord, FormInventoryRecord, LocatorCandidate } from '../schemas/elementInventory.js';
import type { ScopePolicy } from '../net/scope.js';
import type { NetworkRecord } from '../schemas/networkEvidence.js';
import type { ToolStep } from '../schemas/toolDefinition.js';
import type { Capability, CapabilityInput, EvidenceRef } from '../schemas/websiteModel.js';
import { shortHash } from '../core/ids.js';
import { hostnameOf, sameSite, STATIC_ASSET_PATH } from '../net/url.js';

export interface BrowseOptions {
  scope: ScopePolicy;
  pageLoadTimeoutMs: number;
  settleTimeoutMs: number;
  maxElementsPerPage: number;
  maxLinksPerPage: number;
  /** Clicks, fills, selections and presses allowed in the session. */
  maxActions: number;
  /** Pages the session may open. */
  maxOpens: number;
}

export type BrowseActionKind = 'click' | 'fill' | 'select' | 'press';

export interface RecordedAction {
  index: number;
  kind: 'open' | BrowseActionKind;
  /** Page URL before the action. */
  url: string;
  afterUrl: string;
  urlChanged: boolean;
  element?: { elementId: string; kind: string; name?: string; text?: string; locators: LocatorCandidate[] };
  value?: string;
  key?: string;
}

export interface RequestSummary {
  method: string;
  url: string;
  status?: number;
  bodyKeys?: string[];
  responseShape?: NetworkRecord['responseShape'];
  allowedAs?: 'app-request';
  /** Set when the response is not JSON (an opaque or encoded payload, for instance). */
  responseType?: string;
  bytes?: number;
  /** How many identical method+path requests this line stands for. */
  times?: number;
  error?: string;
}

export interface ElementBrief {
  elementId: string;
  kind: string;
  name?: string;
  text?: string;
  tag: string;
  href?: string;
  placeholder?: string;
  inputName?: string;
  type?: string;
  category: string;
  consequential: boolean;
  inDialog: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface BrowseSummary {
  url: string;
  title: string;
  headings: string[];
  textSample: string;
  dialogs: string[];
  elements: ElementBrief[];
  forms: Array<{ formId: string; action: string; method: string; classification: string; hasSensitiveFields: boolean; fieldElementIds: string[] }>;
  /** Embedded frames: a form inside one is reached by opening the frame's URL. */
  frames: Array<{ url: string; sameSite: boolean; visible: boolean }>;
  /** The site's own XHR and fetch traffic since the previous summary (deduplicated): how the model discovers what an action calls. */
  requests: RequestSummary[];
  /** Third-party and static-asset requests left out of `requests`. */
  otherRequests: number;
  truncated: boolean;
  actionIndex: number;
  actionsLeft: number;
  opensLeft: number;
}

export interface RepeatedItems {
  container: string;
  item: string;
  count: number;
  fields: Array<{ selector: string; text: string; href?: string }>;
  sample: string[];
}

/** What the model hands to propose_workflow after a browsing session. */
export interface WorkflowProposal {
  kind: 'search' | 'list' | 'detail';
  name: string;
  title: string;
  description: string;
  entity: string | null;
  inputs: Array<{ name: string; type: 'string' | 'integer'; required: boolean; description: string; example: string; actionIndex: number; mode: 'value' | 'locator' }>;
  extract: { kind: 'item-list' | 'link-list'; item: string | null; fields: Array<{ name: string; selector: string | null; attr: string | null }>; hrefPattern: string | null; maxItems: number };
  resultUrlPattern: string | null;
  expectedOutcome: string;
  confidence: number;
  evidence: Array<{ artifactType: string; refId: string }>;
}

export class BrowseRefusal extends Error {}

const NAME = /^[a-z][a-z0-9_]{1,62}$/;
const SAFE_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace']);
const MAX_REQUESTS = 15;

/**
 * The model's browsing session (D27): a policed browser context the model drives through the harness,
 * with the recorder's guardrails and a log of every action so the session can become a tool program.
 */
export class BrowseSession {
  readonly actions: RecordedAction[] = [];
  private ctx?: IsolatedContext;
  private page?: Page;
  private hosts = new Set<string>();
  private elements = new Map<string, ElementRecord>();
  private forms: FormInventoryRecord[] = [];
  private networkCursor = 0;
  private opens = 0;
  private acts = 0;

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly options: BrowseOptions,
  ) {}

  get opensLeft(): number {
    return Math.max(0, this.options.maxOpens - this.opens);
  }

  get actionsLeft(): number {
    return Math.max(0, this.options.maxActions - this.acts);
  }

  /** URLs the session opened: citable as browsed pages. */
  get visited(): string[] {
    return Array.from(new Set(this.actions.filter((a) => a.kind === 'open').map((a) => a.afterUrl)));
  }

  private ownHost(raw: string): boolean {
    try {
      return this.allowedHost(new URL(raw));
    } catch {
      return false;
    }
  }

  private allowedHost(url: URL): boolean {
    return this.options.scope.isHostAllowed(url.hostname) || sameSite(url.hostname, hostnameOf(this.options.scope.data.origin));
  }

  async open(rawUrl: string): Promise<BrowseSummary> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BrowseRefusal(`not an absolute URL: ${rawUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowseRefusal(`unsupported scheme: ${url.protocol}`);
    if (!this.allowedHost(url)) throw new BrowseRefusal(`out of scope: ${url.hostname} is neither an allowed host nor same-site with ${this.options.scope.data.origin}`);
    if (this.options.scope.isProhibitedPath(url.toString())) throw new BrowseRefusal(`prohibited path: ${url.pathname}`);
    if (this.opens >= this.options.maxOpens) throw new BrowseRefusal('open budget exhausted');
    this.opens += 1;
    // One context per set of hosts: a same-site host not yet covered gets a fresh context that includes it.
    if (!this.ctx || !this.hosts.has(url.hostname)) {
      await this.ctx?.close();
      this.hosts.add(url.hostname);
      const extraHosts = Array.from(this.hosts).filter((h) => !this.options.scope.isHostAllowed(h));
      this.ctx = await this.runtime.newContext({ pageUrl: url.toString(), probeId: 'harness-browse' }, { extraHosts });
      this.page = await this.ctx.context.newPage();
      this.page.setDefaultTimeout(Math.min(this.options.pageLoadTimeoutMs, 10_000));
      this.networkCursor = 0;
    }
    const before = this.page!.url();
    await gotoWithPolicy(this.page!, url.toString(), { timeout: this.options.pageLoadTimeoutMs });
    await settle(this.page!, this.options.settleTimeoutMs);
    const after = this.page!.url();
    this.actions.push({ index: this.actions.length, kind: 'open', url: before, afterUrl: after, urlChanged: before !== after });
    return this.summary();
  }

  async act(input: { action: BrowseActionKind; elementId: string; value?: string | null; key?: string | null }): Promise<BrowseSummary> {
    const page = this.page;
    if (!page) throw new BrowseRefusal('open a page first');
    if (this.acts >= this.options.maxActions) throw new BrowseRefusal('action budget exhausted');
    const el = this.elements.get(input.elementId);
    if (!el) throw new BrowseRefusal(`unknown elementId ${input.elementId}; use ids from the latest summary`);
    this.assertActionable(el, input.action, input.value ?? undefined);
    const candidate = preferredLocator(el.locators);
    if (!candidate) throw new BrowseRefusal('the element has no usable locator');
    const locator = toLocator(page, candidate);
    if ((await locator.count()) === 0) throw new BrowseRefusal(`${candidate.strategy} ${candidate.value} no longer matches; read the page again`);
    const target = locator.first();
    const before = page.url();
    this.acts += 1;
    const value = input.value ?? undefined;
    const key = input.key ?? undefined;
    if (input.action === 'click') await target.click({ noWaitAfter: true });
    else if (input.action === 'fill') await target.fill(value ?? '');
    else if (input.action === 'select') {
      try {
        await target.selectOption(value ?? '');
      } catch {
        await target.selectOption({ label: value ?? '' });
      }
    } else {
      if (!key || !SAFE_KEYS.has(key)) throw new BrowseRefusal(`key must be one of ${Array.from(SAFE_KEYS).join(', ')}`);
      await target.press(key, { noWaitAfter: true });
    }
    // Wait for the page to react: a navigation, or the DOM settling.
    const deadline = Date.now() + this.options.settleTimeoutMs;
    while (page.url() === before && Date.now() < deadline - this.options.settleTimeoutMs / 2) await page.waitForTimeout(100);
    if (page.url() !== before) await page.waitForLoadState('domcontentloaded', { timeout: this.options.pageLoadTimeoutMs }).catch(() => {});
    await settle(page, this.options.settleTimeoutMs);
    const after = page.url();
    if (!this.options.scope.isInScope(after) && !this.allowedHost(new URL(after))) throw new BrowseRefusal(`the action navigated out of scope to ${after}`);
    this.actions.push({ index: this.actions.length, kind: input.action, url: before, afterUrl: after, urlChanged: before !== after, element: { elementId: el.elementId, kind: el.kind, name: el.name, text: el.text, locators: el.locators }, ...(value !== undefined ? { value } : {}), ...(key ? { key } : {}) });
    return this.summary();
  }

  /** Text of matching elements, or the repeated items the page shows (to design an extractor). */
  async read(input: { selector?: string | null; mode: 'text' | 'items' }): Promise<{ text?: Array<{ selector: string; text: string; tag: string; classes: string }>; items?: RepeatedItems | null }> {
    const page = this.page;
    if (!page) throw new BrowseRefusal('open a page first');
    if (input.mode === 'text') {
      if (!input.selector) throw new BrowseRefusal('text mode needs a selector');
      const text = await evaluateInPage(page, readTextInPage, { selector: input.selector });
      return { text };
    }
    const items = await evaluateInPage(page, detectRepeatedItemsInPage, { within: input.selector ?? null });
    return { items };
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = undefined;
    this.page = undefined;
  }

  private assertActionable(el: ElementRecord, action: BrowseActionKind, value?: string): void {
    const label = `${el.kind} "${el.name ?? el.text ?? el.attributes.id ?? el.tag}"`;
    if (!el.visible) throw new BrowseRefusal(`${label} is not visible`);
    if (el.consequential || el.category === 'consequential') throw new BrowseRefusal(`${label} is a consequential control (${el.consequentialReasons?.join(', ') || 'buy, delete, send, submit…'}); WebMorph never activates those`);
    if (el.category === 'authentication' || AUTH_PATTERN.test(el.name ?? '')) throw new BrowseRefusal(`${label} is an authentication control; WebMorph never signs in`);
    if (el.inDialog && isConsentLike(el.name ?? '')) throw new BrowseRefusal(`${label} is a consent control; WebMorph never accepts or declines consent`);
    const form = el.formId ? this.forms.find((f) => f.formId === el.formId) : undefined;
    if (form?.hasSensitiveFields) throw new BrowseRefusal(`${label} belongs to a form with sensitive fields; WebMorph never fills or submits those`);
    if (action === 'fill') {
      const type = el.attributes.type?.toLowerCase();
      if (type && NEVER_FILL_TYPES.includes(type)) throw new BrowseRefusal(`${label} is a ${type} field; WebMorph never fills it`);
      if (el.kind !== 'textbox' && el.kind !== 'searchbox' && el.kind !== 'combobox' && el.tag !== 'input' && el.tag !== 'textarea') throw new BrowseRefusal(`${label} cannot be filled`);
      if (!value) throw new BrowseRefusal('fill needs a value');
    }
    if (action === 'select') {
      if (!el.options?.length) throw new BrowseRefusal(`${label} has no options`);
      if (!value || !el.options.some((o) => o.value === value || o.label === value)) throw new BrowseRefusal(`value must be one of ${el.options.map((o) => o.value || o.label).join(', ')}`);
    }
    if (action === 'click' && form && form.method === 'post' && (el.kind === 'button' || el.attributes.type === 'submit')) throw new BrowseRefusal(`${label} submits a POST form; WebMorph never submits forms`);
  }

  private async summary(): Promise<BrowseSummary> {
    const page = this.page!;
    const snapshot: PageSnapshot = await evaluateInPage(page, collectPageSnapshot, { maxElements: this.options.maxElementsPerPage, maxLinks: this.options.maxLinksPerPage });
    const { elements, forms } = buildInventory(snapshot, page.url());
    this.elements = new Map(elements.map((e) => [e.elementId, e]));
    this.forms = forms;
    const textSample = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)).catch(() => '');
    const frames = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('iframe'))
          .map((f) => ({ url: f.src, visible: f.getBoundingClientRect().width > 50 && f.getBoundingClientRect().height > 50 }))
          .filter((f) => /^https?:/.test(f.url))
          .slice(0, 10),
      )
      .catch(() => [] as Array<{ url: string; visible: boolean }>);
    const records = this.ctx!.stats.network.slice(this.networkCursor);
    this.networkCursor = this.ctx!.stats.network.length;
    const { requests, otherRequests } = summarizeRequests(records, (url) => this.ownHost(url));
    return {
      url: page.url(),
      title: snapshot.title,
      headings: snapshot.headings.slice(0, 20).map((h) => h.text),
      textSample,
      dialogs: snapshot.dialogs.map((d) => `${d.role}${d.name ? ` "${d.name}"` : ''}: ${d.textSample.slice(0, 120)}${d.buttonNames.length ? ` [${d.buttonNames.join(', ')}]` : ''}`),
      frames: frames.map((f) => ({ url: f.url.slice(0, 200), sameSite: this.ownHost(f.url), visible: f.visible })),
      elements: elements
        .filter((e) => e.visible)
        .slice(0, 100)
        .map((e) => ({ elementId: e.elementId, kind: e.kind, ...(e.name ? { name: e.name.slice(0, 80) } : {}), ...(e.text && e.text !== e.name ? { text: e.text.slice(0, 80) } : {}), tag: e.tag, ...(e.attributes.href ? { href: e.attributes.href } : {}), ...(e.attributes.placeholder ? { placeholder: e.attributes.placeholder } : {}), ...(e.attributes.name ? { inputName: e.attributes.name } : {}), ...(e.attributes.type ? { type: e.attributes.type } : {}), category: e.category, consequential: e.consequential, inDialog: e.inDialog, ...(e.options?.length ? { options: e.options.slice(0, 30) } : {}) })),
      forms: forms.map((f) => ({ formId: f.formId, action: f.action, method: f.method, classification: f.classification, hasSensitiveFields: f.hasSensitiveFields, fieldElementIds: f.fieldElementIds })),
      requests,
      otherRequests,
      truncated: snapshot.truncated,
      actionIndex: this.actions.length - 1,
      actionsLeft: this.actionsLeft,
      opensLeft: this.opensLeft,
    };
  }

  /**
   * Turn the recorded session into a capability with a declarative program. Inputs bind to recorded
   * actions: `value` replaces what was typed or selected, `locator` replaces the clicked option's name.
   * Throws a BrowseRefusal with the reason when the proposal cannot become a replayable program.
   */
  buildWorkflowCapability(p: WorkflowProposal, origin: string): Capability {
    if (!NAME.test(p.name)) throw new BrowseRefusal('name must be snake_case (a-z, 0-9, _)');
    if (!this.actions.length) throw new BrowseRefusal('no browsing session to turn into a program');
    const names = new Set<string>();
    for (const i of p.inputs) {
      if (!NAME.test(i.name)) throw new BrowseRefusal(`input ${i.name} must be snake_case`);
      if (names.has(i.name)) throw new BrowseRefusal(`input ${i.name} is listed twice`);
      names.add(i.name);
      const action = this.actions[i.actionIndex];
      if (!action) throw new BrowseRefusal(`input ${i.name}: actionIndex ${i.actionIndex} is not a recorded action (0 to ${this.actions.length - 1})`);
      if (!i.example) throw new BrowseRefusal(`input ${i.name} needs the example value used in the session`);
      if (i.mode === 'value' && action.kind !== 'fill' && action.kind !== 'select' && action.kind !== 'open') throw new BrowseRefusal(`input ${i.name}: value binding needs a fill, select or open action, not ${action.kind}`);
      if (i.mode === 'value' && action.kind === 'open' && !action.afterUrl.includes(i.example) && !action.url.includes(i.example)) throw new BrowseRefusal(`input ${i.name}: the opened URL does not contain the example value "${i.example}"`);
      if (i.mode === 'value' && action.kind !== 'open' && action.value !== i.example) throw new BrowseRefusal(`input ${i.name}: action ${i.actionIndex} used "${action.value ?? ''}", not "${i.example}"`);
      if (i.mode === 'locator' && (action.kind !== 'click' || !action.element?.locators.some((l) => l.value.includes(i.example)))) throw new BrowseRefusal(`input ${i.name}: no locator of the clicked element at action ${i.actionIndex} contains "${i.example}"; bind to the option you clicked`);
    }
    const bound = new Map<number, (typeof p.inputs)[number]>();
    for (const i of p.inputs) bound.set(i.actionIndex, i);
    const steps: ToolStep[] = [];
    const settleMs = Math.max(this.options.settleTimeoutMs, 1000);
    let firstUrl: string | undefined;
    for (const a of this.actions) {
      const input = bound.get(a.index);
      if (a.kind === 'open') {
        let url = a.afterUrl;
        if (input) url = url.includes(input.example) ? url.replace(input.example, `{{${input.name}}}`) : a.url.replace(input.example, `{{${input.name}}}`);
        firstUrl ??= a.afterUrl;
        steps.push({ op: 'navigate', url });
        steps.push({ op: 'wait', for: 'dom-stable', timeoutMs: settleMs });
        continue;
      }
      const element = a.element!;
      let locator = preferredLocator(element.locators)!;
      if (a.kind === 'click') {
        if (input) {
          const semantic = element.locators.filter((l) => l.value.includes(input.example)).sort((x, y) => Number(['role', 'text', 'label', 'title', 'alt'].includes(y.strategy)) - Number(['role', 'text', 'label', 'title', 'alt'].includes(x.strategy)) || y.score - x.score)[0]!;
          locator = { ...semantic, value: semantic.value.replace(input.example, `{{${input.name}}}`) };
        }
        steps.push({ op: 'click', locator });
      } else if (a.kind === 'fill' || a.kind === 'select') {
        if (!input) throw new BrowseRefusal(`action ${a.index} (${a.kind} "${a.value ?? ''}") must be bound to an input; a tool cannot replay a hard-coded ${a.kind}`);
        steps.push({ op: a.kind, locator, valueFrom: input.name });
      } else if (a.kind === 'press') steps.push({ op: 'press', locator, key: a.key ?? 'Enter' });
      steps.push(a.urlChanged ? { op: 'wait', for: 'navigation', timeoutMs: settleMs * 2 } : { op: 'wait', for: 'dom-stable', timeoutMs: settleMs });
    }
    if (p.resultUrlPattern) steps.push({ op: 'assert', check: 'url-matches', value: p.resultUrlPattern });
    let outputSchema: Record<string, unknown>;
    if (p.extract.kind === 'item-list') {
      if (!p.extract.item) throw new BrowseRefusal('item-list extraction needs the item selector');
      if (!p.extract.fields.length) throw new BrowseRefusal('item-list extraction needs at least one field');
      const fields = Object.fromEntries(p.extract.fields.map((f) => [f.name, { ...(f.selector ? { selector: f.selector } : {}), ...(f.attr ? { attr: f.attr } : {}) }]));
      steps.push({ op: 'extract', extractor: { kind: 'item-list', into: 'results', item: p.extract.item, fields, maxItems: Math.min(Math.max(p.extract.maxItems, 1), 200) } });
      outputSchema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: Object.fromEntries(p.extract.fields.map((f) => [f.name, { type: 'string' }])), required: p.extract.fields.map((f) => f.name), additionalProperties: false } }, count: { type: 'integer', minimum: 0 }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'], additionalProperties: false };
    } else {
      steps.push({ op: 'extract', extractor: { kind: 'link-list', into: 'results', scope: 'body', hrefPattern: p.extract.hrefPattern ?? '^/.+', maxItems: Math.min(Math.max(p.extract.maxItems, 1), 200) } });
      outputSchema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'], additionalProperties: false } }, count: { type: 'integer', minimum: 0 }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'], additionalProperties: false };
    }
    const inputs: CapabilityInput[] = p.inputs.map((i) => ({ name: i.name, type: i.type, required: i.required, description: i.description, source: 'form-field', example: i.example }));
    const evidence: EvidenceRef[] = [...p.evidence.map((e) => ({ artifactType: e.artifactType as EvidenceRef['artifactType'], refId: e.refId, note: 'cited by the model harness' })), ...this.visited.map((url) => ({ artifactType: 'PageModel' as const, refId: url, note: 'browsed by the model harness' }))];
    const entity = p.entity ? p.entity.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : undefined;
    return {
      capabilityId: `cap-${shortHash(`workflow|${p.kind}|${p.name}|${JSON.stringify(steps)}`, 10)}`,
      kind: p.kind,
      name: p.name,
      title: p.title.trim().slice(0, 80),
      description: p.description.trim().slice(0, 400),
      status: 'inferred',
      confidence: Math.min(Number(p.confidence) || 0.5, 0.7),
      pageUrl: firstUrl ?? origin,
      ...(entity ? { entity } : {}),
      inputs,
      outputs: [{ name: 'results', type: 'array' }, { name: 'count', type: 'integer' }],
      preconditions: ['the page flow still works as browsed'],
      expectedOutcome: p.expectedOutcome.slice(0, 300),
      sideEffectClass: 'read',
      authRequirement: 'none',
      mechanics: { navigateUrl: firstUrl ?? origin, program: steps as unknown as Array<Record<string, unknown>>, outputSchema },
      evidence,
      source: 'model',
    };
  }
}

/** Browser-side: text of up to 20 matches of a selector. Self-contained for evaluateInPage. */
function readTextInPage(arg: { selector: string }): Array<{ selector: string; text: string; tag: string; classes: string }> {
  const out: Array<{ selector: string; text: string; tag: string; classes: string }> = [];
  for (const node of Array.from(document.querySelectorAll(arg.selector)).slice(0, 20)) {
    const el = node as HTMLElement;
    out.push({ selector: arg.selector, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300), tag: el.tagName.toLowerCase(), classes: el.className && typeof el.className === 'string' ? el.className : '' });
  }
  return out;
}

/**
 * Browser-side: the most prominent group of repeated sibling elements (result rows, cards), with the
 * relative selectors of the text-bearing parts of its first item. Self-contained for evaluateInPage.
 */
function detectRepeatedItemsInPage(arg: { within: string | null }): { container: string; item: string; count: number; fields: Array<{ selector: string; text: string; href?: string }>; sample: string[] } | null {
  const root = (arg.within ? document.querySelector(arg.within) : null) ?? document.body;
  const sig = (el: Element) => `${el.tagName.toLowerCase()}${el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : ''}`;
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      if (cur.classList.length) part += '.' + Array.from(cur.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  let best: { container: Element; items: Element[]; score: number } | null = null;
  const all = [root, ...Array.from(root.querySelectorAll('*'))].filter((e) => e.children.length >= 3 && !e.closest('header, nav, footer, [role="navigation"], [role="menu"]'));
  for (const container of all) {
    const groups = new Map<string, Element[]>();
    for (const child of Array.from(container.children)) {
      // Only rendered elements can be result items: never scripts, styles or templates, never hidden nodes.
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(child.tagName) || child.getBoundingClientRect().height === 0) continue;
      const s = sig(child);
      groups.set(s, [...(groups.get(s) ?? []), child]);
    }
    for (const items of groups.values()) {
      if (items.length < 3) continue;
      const text = items.reduce((n, it) => n + ((it as HTMLElement).innerText || '').trim().length, 0);
      if (text < 20) continue;
      const score = items.length * Math.log(1 + text);
      if (!best || score > best.score) best = { container, items, score };
    }
  }
  if (!best) return null;
  const first = best.items[0]!;
  const fields: Array<{ selector: string; text: string; href?: string }> = [];
  const rel = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== first && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList.length) part += '.' + Array.from(cur.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const leaves = Array.from(first.querySelectorAll('*')).filter((e) => Array.from(e.children).every((c) => !(c as HTMLElement).innerText?.trim()) && ((e as HTMLElement).innerText || '').trim());
  for (const leaf of leaves.slice(0, 12)) {
    const href = leaf instanceof HTMLAnchorElement ? leaf.href : undefined;
    fields.push({ selector: rel(leaf), text: ((leaf as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), ...(href ? { href } : {}) });
  }
  for (const a of Array.from(first.querySelectorAll('a[href]')).slice(0, 3)) if (!fields.some((f) => f.href)) fields.push({ selector: rel(a), text: ((a as HTMLElement).innerText || '').trim().slice(0, 80), href: (a as HTMLAnchorElement).href });
  return { container: pathOf(best.container), item: `${pathOf(best.container)} > ${sig(first)}`, count: best.items.length, fields, sample: best.items.slice(0, 3).map((it) => ((it as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)) };
}

const str = (opts: { description: string; nullable?: boolean }) => ({ type: opts.nullable ? ['string', 'null'] : 'string', description: opts.description });
const obj = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false });

/** The browsing tools offered to the model (strict schemas). */
/**
 * The site's own XHR and fetch requests, one line per method and path (with a count), API-looking calls first.
 * Third-party traffic (analytics, telemetry, chat widgets) and static assets are counted, not listed.
 */
export function summarizeRequests(records: NetworkRecord[], own: (url: string) => boolean): { requests: RequestSummary[]; otherRequests: number } {
  const lines = new Map<string, RequestSummary>();
  let otherRequests = 0;
  for (const r of records) {
    if (r.resourceType !== 'xhr' && r.resourceType !== 'fetch') continue;
    let path: string;
    try {
      const u = new URL(r.url);
      path = `${u.origin}${u.pathname}`;
    } catch {
      continue;
    }
    if (!own(r.url) || STATIC_ASSET_PATH.test(path)) {
      otherRequests += 1;
      continue;
    }
    const key = `${r.method} ${path}`;
    const seen = lines.get(key);
    if (seen) {
      seen.times = (seen.times ?? 1) + 1;
      continue;
    }
    const json = /json/i.test(r.responseContentType ?? '');
    lines.set(key, {
      method: r.method,
      url: r.url.slice(0, 160),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.requestBodyKeys ? { bodyKeys: r.requestBodyKeys } : {}),
      ...(r.responseShape ? { responseShape: r.responseShape } : {}),
      ...(r.responseContentType && !json ? { responseType: r.responseContentType.split(';')[0]! } : {}),
      ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
      ...(r.allowedAs ? { allowedAs: r.allowedAs } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  const apiFirst = (s: RequestSummary) => (s.responseShape || s.method !== 'GET' ? 0 : 1);
  const requests = Array.from(lines.values()).sort((a, b) => apiFirst(a) - apiFirst(b)).slice(0, MAX_REQUESTS);
  return { requests, otherRequests: otherRequests + Math.max(0, lines.size - MAX_REQUESTS) };
}

export function browseToolDefinitions(): Anthropic.Beta.BetaTool[] {
  return [
    {
      name: 'browse_open',
      description: 'Open a page in your browsing session (in-scope or same-site host) and return what is on it: title, headings, text sample, dialogs, embedded frames (open the frame URL to work inside it), interactive elements with ids, forms, and the own-site XHR/fetch requests (deduplicated; third-party and static-asset traffic only counted). Use the element ids with browse_act. Counts against the open budget.',
      strict: true,
      input_schema: obj({ url: str({ description: 'Absolute URL.' }) }),
    },
    {
      name: 'browse_act',
      description: 'Act on an element of the current page by elementId: click, fill (textbox or searchbox), select (an option of a select) or press a key (Enter, Tab, Escape, arrows). Returns the page afterwards and the requests the action caused. Consequential controls (buy, delete, send, sign in, consent), password-like fields and POST forms are refused. Counts against the action budget.',
      strict: true,
      input_schema: obj({
        action: { type: 'string', enum: ['click', 'fill', 'select', 'press'] },
        elementId: str({ description: 'elementId from the latest summary.' }),
        value: str({ description: 'Text to fill or option to select; null otherwise.', nullable: true }),
        key: str({ description: 'Key for press (Enter, Tab, Escape, ArrowDown, …); null otherwise.', nullable: true }),
      }),
    },
    {
      name: 'browse_read',
      description: 'Read the current page: mode "items" finds the most prominent group of repeated result elements (rows, cards) and returns the item selector, count, a sample, and the relative selectors of its text parts, which you can use as fields of an item-list extractor; mode "text" returns the text of up to 20 elements matching a CSS selector.',
      strict: true,
      input_schema: obj({ mode: { type: 'string', enum: ['items', 'text'] }, selector: str({ description: 'CSS selector (required for text; optional container for items), or null.', nullable: true }) }),
    },
    {
      name: 'propose_workflow',
      description: 'Turn your browsing session into a tool. Name the inputs and bind each to a recorded action (actionIndex from the summaries): mode "value" replaces what you filled, selected or put in an opened URL; mode "locator" replaces the option you clicked (the clicked element must have a locator containing the example). Choose the extractor: item-list with the item selector and fields from browse_read, or link-list with an hrefPattern. The harness builds the program, generates the tool and replays it in a fresh browser; the proposal is kept only if it validates, and you are told why otherwise.',
      strict: true,
      input_schema: obj({
        kind: { type: 'string', enum: ['search', 'list', 'detail'] },
        name: str({ description: 'snake_case tool-style name.' }),
        title: str({ description: 'Short title.' }),
        description: str({ description: 'What an agent gets by calling it.' }),
        entity: str({ description: 'Entity name, or null.', nullable: true }),
        inputs: {
          type: 'array',
          items: obj({
            name: str({ description: 'snake_case input name.' }),
            type: { type: 'string', enum: ['string', 'integer'] },
            required: { type: 'boolean' },
            description: str({ description: 'What the input means and accepted values.' }),
            example: str({ description: 'The exact value used in the session.' }),
            actionIndex: { type: 'integer', description: 'Index of the recorded action this input parameterizes.' },
            mode: { type: 'string', enum: ['value', 'locator'] },
          }),
        },
        extract: obj({
          kind: { type: 'string', enum: ['item-list', 'link-list'] },
          item: str({ description: 'CSS selector of one result item (item-list), or null.', nullable: true }),
          fields: { type: 'array', items: obj({ name: str({ description: 'snake_case field name.' }), selector: str({ description: 'CSS selector relative to the item, or null for the item text.', nullable: true }), attr: str({ description: 'Attribute to read (href, src), or null for text.', nullable: true }) }) },
          hrefPattern: str({ description: 'Regular expression over result link paths (link-list), or null.', nullable: true }),
          maxItems: { type: 'integer' },
        }),
        resultUrlPattern: str({ description: 'Regular expression the results page URL must match, or null.', nullable: true }),
        expectedOutcome: str({ description: 'What a successful call returns.' }),
        confidence: { type: 'number' },
        evidence: { type: 'array', items: obj({ artifactType: str({ description: 'Artifact type of a record you cite.' }), refId: str({ description: 'Its id or URL.' }) }) },
      }),
    },
  ];
}
