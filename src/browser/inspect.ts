import type { Page } from 'playwright';
import type { ScopePolicy } from '../net/scope.js';
import { shortHash } from '../core/ids.js';
import { detectBlockSignal } from '../html/blocked.js';
import { classifyFormFacts, formHasSensitiveFields, sideEffectHintFor } from '../html/forms.js';
import type { FormField } from '../schemas/pageInventory.js';
import type { BlobRef } from '../schemas/common.js';
import type { NetworkRecord } from '../schemas/networkEvidence.js';
import type { InspectedPage, DialogRecord } from '../schemas/pageModel.js';
import type { ElementRecord, FormInventoryRecord } from '../schemas/elementInventory.js';
import { collectPageSnapshot, collectQuickState, type PageSnapshot, type QuickState, type RawElement } from './collect.js';
import { evaluateInPage } from './evaluate.js';
import { classifyElement, type FormContext } from './classify.js';
import { buildFormLocators, buildLocators } from './locators.js';
import { gotoWithPolicy, type BrowserRuntime } from './runtime.js';

export type BlobWriter = (subdir: string, contentType: string, data: Buffer, ext: string) => Promise<BlobRef>;
export type NetworkSink = (records: NetworkRecord[]) => Promise<void>;

export interface InspectOptions {
  url: string;
  templateId?: string;
  staticTextLength?: number;
  scope: ScopePolicy;
  pageLoadTimeoutMs: number;
  settleTimeoutMs: number;
  maxElementsPerPage: number;
  maxLinksPerPage: number;
  captureScreenshot: boolean;
  captureDom: boolean;
}

export interface InspectResult {
  page: InspectedPage;
  elements: ElementRecord[];
  forms: FormInventoryRecord[];
  truncated: boolean;
}

/** Navigate and wait until the DOM stops changing or the settle budget is spent. */
export async function settle(page: Page, timeoutMs: number): Promise<boolean> {
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5_000) }).catch(() => {});
  const started = Date.now();
  let last = -1;
  let stableFor = 0;
  while (Date.now() - started < timeoutMs) {
    let len: number;
    try {
      len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
    } catch {
      await page.waitForTimeout(150);
      continue;
    }
    if (len === last) {
      stableFor += 200;
      if (stableFor >= 500) return true;
    } else {
      stableFor = 0;
      last = len;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

export async function quickState(page: Page): Promise<QuickState> {
  return evaluateInPage(page, collectQuickState);
}

export async function inspectPage(runtime: BrowserRuntime, options: InspectOptions, blobs: BlobWriter, networkSink?: NetworkSink): Promise<InspectResult> {
  const started = Date.now();
  const { context, stats, close } = await runtime.newContext({ pageUrl: options.url });
  const base: Omit<InspectedPage, 'outcome' | 'rendered' | 'hydration' | 'regions' | 'dialogs' | 'ariaSnapshotExcerpt' | 'loadMs' | 'settled' | 'consoleErrors' | 'failedRequests' | 'blockedRequests'> = {
    url: options.url,
    finalUrl: options.url,
    ...(options.templateId ? { templateId: options.templateId } : {}),
  };
  const empty = (outcome: InspectedPage['outcome'], error?: string, extra: Partial<InspectedPage> = {}): InspectResult => ({
    page: {
      ...base,
      ...extra,
      outcome,
      ...(error ? { error } : {}),
      loadMs: Date.now() - started,
      settled: false,
      rendered: { textLength: 0, linkCount: 0, interactiveCount: 0, headings: [], stateHash: '' },
      hydration: { staticTextLength: options.staticTextLength, renderedTextLength: 0 },
      regions: [],
      dialogs: [],
      consoleErrors: stats.consoleErrors,
      failedRequests: stats.failedRequests,
      blockedRequests: stats.blockedRequests,
      ariaSnapshotExcerpt: '',
    },
    elements: [],
    forms: [],
    truncated: false,
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(options.pageLoadTimeoutMs);
    let response: Awaited<ReturnType<Page['goto']>>;
    try {
      ({ response } = await gotoWithPolicy(page, options.url, { timeout: options.pageLoadTimeoutMs }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Timeout/i.test(message)) return empty('timeout', message.split('\n')[0]);
      if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return empty('out-of-scope', 'navigation refused by scope or SSRF policy');
      if (/ERR_TOO_MANY_REDIRECTS/.test(message)) return empty('navigation-failed', 'redirect loop');
      return empty('navigation-failed', message.split('\n')[0]);
    }

    const settled = await settle(page, options.settleTimeoutMs);
    const finalUrl = page.url();
    if (!options.scope.isInScope(finalUrl)) return empty('out-of-scope', `landed on ${finalUrl}`, { finalUrl });

    const status = response?.status();
    const headers = response?.headers() ?? {};
    if (status !== undefined && status >= 400) {
      const bodyText = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 20000)).catch(() => '');
      const signal = detectBlockSignal(status, headers, bodyText);
      if (signal) return empty('blocked', `HTTP ${status}`, { finalUrl, status, blockedSignal: signal });
      return empty('navigation-failed', `HTTP ${status}`, { finalUrl, status });
    }

    const snapshot: PageSnapshot = await evaluateInPage(page, collectPageSnapshot, { maxElements: options.maxElementsPerPage, maxLinks: options.maxLinksPerPage });
    const aria = await page.locator('body').ariaSnapshot().catch(() => '');

    const [ariaBlob, screenshot, domSnapshot] = await Promise.all([
      aria ? blobs('aria', 'text/yaml', Buffer.from(aria, 'utf8'), '.yaml') : Promise.resolve(undefined),
      options.captureScreenshot ? page.screenshot({ type: 'png', fullPage: false }).then((buf) => blobs('screenshots', 'image/png', buf, '.png')).catch(() => undefined) : Promise.resolve(undefined),
      options.captureDom ? page.content().then((html) => blobs('dom-snapshots', 'text/html', Buffer.from(html, 'utf8'), '.html')).catch(() => undefined) : Promise.resolve(undefined),
    ]);

    const { elements, forms } = buildInventory(snapshot, finalUrl);
    const dialogs: DialogRecord[] = snapshot.dialogs.map((d) => ({
      role: d.role,
      name: d.name,
      kind: classifyDialog(`${d.name ?? ''} ${d.textSample}`),
      modal: d.modal,
      textSample: d.textSample,
      buttonNames: d.buttonNames,
    }));
    const rendered = snapshot.textLength;
    const result: InspectedPage = {
      ...base,
      finalUrl,
      status,
      outcome: 'ok',
      title: snapshot.title || undefined,
      loadMs: Date.now() - started,
      settled,
      rendered: {
        textLength: rendered,
        linkCount: snapshot.linkCount,
        interactiveCount: snapshot.interactiveCount,
        headings: snapshot.headings,
        stateHash: snapshot.stateHash,
      },
      hydration: {
        staticTextLength: options.staticTextLength,
        renderedTextLength: rendered,
        ...(options.staticTextLength !== undefined ? { delta: rendered - options.staticTextLength } : {}),
      },
      regions: snapshot.regions,
      dialogs,
      consoleErrors: stats.consoleErrors,
      failedRequests: stats.failedRequests,
      blockedRequests: stats.blockedRequests,
      ariaSnapshotExcerpt: aria.slice(0, 2000),
      ...(ariaBlob ? { ariaSnapshot: ariaBlob } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(domSnapshot ? { domSnapshot } : {}),
    };
    return { page: result, elements, forms, truncated: snapshot.truncated };
  } catch (err) {
    return empty('error', err instanceof Error ? err.message.split('\n')[0] : String(err));
  } finally {
    await close();
    if (networkSink && stats.network.length) await networkSink(stats.network).catch(() => {});
  }
}

function classifyDialog(text: string): DialogRecord['kind'] {
  if (/cookie|consent|gdpr|privacy/i.test(text)) return 'consent';
  if (/sign in|log in|password|register/i.test(text)) return 'auth';
  if (/newsletter|subscribe/i.test(text)) return 'newsletter';
  return 'other';
}

function rawToField(raw: RawElement): FormField {
  return {
    name: raw.attrs.name,
    type: raw.tag === 'input' ? raw.attrs.type ?? 'text' : raw.tag,
    label: raw.name,
    placeholder: raw.attrs.placeholder,
    required: false,
  };
}

export function buildInventory(snapshot: PageSnapshot, pageUrl: string): { elements: ElementRecord[]; forms: FormInventoryRecord[]; formContexts: Map<number, FormContext> } {
  const byIndex = new Map(snapshot.elements.map((e) => [e.index, e]));
  const idFor = (raw: RawElement) => `el-${shortHash(`${pageUrl}|${raw.cssPath}|${raw.index}`, 10)}`;

  const formContexts = new Map<number, FormContext>();
  const forms: FormInventoryRecord[] = snapshot.forms.map((f) => {
    const fieldRaws = f.fieldIndexes.map((i) => byIndex.get(i)).filter((x): x is RawElement => Boolean(x));
    const fields = fieldRaws.map(rawToField);
    const method: FormContext['method'] = f.method === 'get' ? 'get' : f.method === 'post' ? 'post' : 'other';
    const classification = classifyFormFacts({ fields, method, action: f.action, attrs: f.attrs, hasPassword: f.hasPassword });
    formContexts.set(f.index, { classification, method, hasPassword: f.hasPassword });
    const submitRaw = f.submitIndex !== undefined ? byIndex.get(f.submitIndex) : undefined;
    return {
      formId: `form-${shortHash(`${pageUrl}|${f.cssPath}|${f.index}`, 10)}`,
      pageUrl,
      action: f.action,
      method,
      classification,
      sideEffectHint: sideEffectHintFor(method, f.hasPassword),
      fieldElementIds: fieldRaws.map(idFor),
      ...(submitRaw ? { submitElementId: idFor(submitRaw) } : {}),
      locators: buildFormLocators(f),
      hasSensitiveFields: f.hasPassword || formHasSensitiveFields(fields),
    };
  });
  const formIdByIndex = new Map(snapshot.forms.map((f, i) => [f.index, forms[i]!.formId]));

  const elements: ElementRecord[] = snapshot.elements.map((raw) => {
    const formCtx = raw.formIndex !== undefined ? formContexts.get(raw.formIndex) : undefined;
    const c = classifyElement(raw, formCtx);
    const { testIdAttr: _attr, ...attrs } = raw.attrs;
    return {
      elementId: idFor(raw),
      pageUrl,
      kind: c.kind,
      role: raw.role,
      name: raw.name,
      text: raw.text,
      tag: raw.tag,
      attributes: attrs,
      ...(raw.options ? { options: raw.options } : {}),
      visible: raw.visible,
      inViewport: raw.inViewport,
      ...(raw.box ? { boundingBox: raw.box } : {}),
      region: raw.region,
      inDialog: raw.inDialog,
      ...(raw.formIndex !== undefined && formIdByIndex.has(raw.formIndex) ? { formId: formIdByIndex.get(raw.formIndex)! } : {}),
      category: c.category,
      consequential: c.consequential,
      consequentialReasons: c.consequentialReasons,
      locators: buildLocators(raw),
    };
  });

  return { elements, forms, formContexts };
}
