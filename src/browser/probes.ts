import type { Page } from 'playwright';
import type { ScopePolicy } from '../net/scope.js';
import { NEVER_FILL_TYPES } from '../html/forms.js';
import type { ElementRecord, FormInventoryRecord } from '../schemas/elementInventory.js';
import type { InspectedPage } from '../schemas/pageModel.js';
import type { PageState, ProbeAction, ProbeKind, ProbeRecord } from '../schemas/interactionEvidence.js';
import { AUTH_PATTERN, isConsentLike, isNextLink } from './classify.js';
import { preferredLocator, toLocator } from './locators.js';
import { quickState, settle, type NetworkSink } from './inspect.js';
import { gotoWithPolicy, type BrowserRuntime } from './runtime.js';

export interface ProbePolicy {
  allowWriteProbes: boolean;
}

export const NEVER_CLICK_PATTERNS = ['consequential actions (buy, delete, submit, send, sign in, subscribe, accept cookies, ...)', 'anything inside a consent or auth dialog', 'POST form submit buttons'];

export interface ProbePlan {
  kind: ProbeKind;
  pageUrl: string;
  element: ElementRecord;
  form?: FormInventoryRecord;
  action: ProbeAction;
  allowedBecause: string;
  description: string;
  /** For filter probes: click this after selecting when nothing changed on its own. */
  submitElement?: ElementRecord;
}

export interface ProbeBudget {
  pageLoadTimeoutMs: number;
  settleTimeoutMs: number;
}

const STOPWORDS = new Set(['welcome', 'home', 'the', 'and', 'for', 'with', 'your', 'our', 'this', 'that', 'from', 'about', 'page', 'official', 'website', 'site', 'next', 'previous', 'login', 'logout', 'contact', 'search', 'menu', 'more', 'read', 'view', 'all', 'here', 'click', 'skip', 'main', 'content', 'privacy', 'terms', 'cookies', 'accept', 'decline', 'icon', 'icons', 'image', 'images', 'logo', 'badge', 'photo', 'picture', 'avatar', 'button', 'arrow', 'link', 'close', 'open', 'toggle', 'show', 'hide', 'load', 'see', 'new', 'app', 'download', 'share', 'copy', 'back', 'top', 'you', 'are', 'not', 'yes']);

const tokenize = (s: string): string[] =>
  s
    .split(/[^\p{L}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && w.length <= 14 && !STOPWORDS.has(w));

/**
 * A harmless query likely to return results: the most frequent word in the
 * page's in-scope link texts (site vocabulary), else a heading word, else "test".
 */
export function chooseQuery(page: InspectedPage, elements: ElementRecord[] = []): string {
  const counts = new Map<string, number>();
  for (const e of elements) {
    if (e.kind !== 'link' || !e.attributes.href || e.inDialog) continue;
    for (const w of new Set(tokenize(e.name ?? e.text ?? ''))) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const frequent = Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (frequent) return frequent;
  const words = tokenize([...page.rendered.headings.map((h) => h.text), page.title ?? ''].join(' '));
  return words[0] ?? 'test';
}

function describe(el: ElementRecord): string {
  return `${el.kind} "${el.name ?? el.text ?? el.attributes.id ?? el.tag}"`;
}

function eligible(el: ElementRecord, page: InspectedPage): boolean {
  if (!el.visible || el.inDialog || el.consequential) return false;
  if (el.category === 'authentication' || el.category === 'consequential') return false;
  if (AUTH_PATTERN.test(el.name ?? '') || isConsentLike(el.name ?? '')) return false;
  if (!preferredLocator(el.locators)) return false;
  // Never probe anything while a modal consent dialog is up: clicks would land on it.
  if (page.dialogs.some((d) => d.kind === 'consent' && d.modal) && !el.inViewport) return false;
  return true;
}

/**
 * Decide which bounded interactions to try on a page. Read-only by construction:
 * GET searches, GET filters, in-page toggles, tab changes and next-page links.
 */
export function planProbes(page: InspectedPage, elements: ElementRecord[], forms: FormInventoryRecord[], policy: ProbePolicy, maxPerPage: number): { probes: ProbePlan[]; skippedByPolicy: number } {
  const probes: ProbePlan[] = [];
  let skippedByPolicy = 0;
  const pageUrl = page.finalUrl;
  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const used = new Set<string>();
  const push = (p: ProbePlan) => {
    if (probes.length >= maxPerPage || used.has(p.element.elementId)) return;
    used.add(p.element.elementId);
    probes.push(p);
  };

  // 1. Search: GET form classified search with a fillable text field.
  for (const form of forms.filter((f) => f.classification === 'search' && f.method === 'get')) {
    if (form.hasSensitiveFields) {
      skippedByPolicy += 1;
      continue;
    }
    const field = form.fieldElementIds.map((id) => byId.get(id)).find((e) => e && (e.kind === 'searchbox' || e.kind === 'textbox') && !NEVER_FILL_TYPES.includes(e.attributes.type ?? 'text') && eligible(e, page));
    if (!field) continue;
    push({
      kind: 'search-submit',
      pageUrl,
      element: field,
      form,
      action: { type: 'fill-and-submit', locator: preferredLocator(field.locators)!, value: chooseQuery(page, elements) },
      allowedBecause: 'GET search form without sensitive fields; submitting is a read',
      description: `search via ${describe(field)}`,
    });
  }

  // 2. Pagination: an in-scope next link.
  const next = elements.find((e) => e.kind === 'link' && isNextLikeRecord(e) && eligible(e, page));
  if (next) {
    push({
      kind: 'pagination',
      pageUrl,
      element: next,
      action: { type: 'click', locator: preferredLocator(next.locators)! },
      allowedBecause: 'in-scope navigation link',
      description: `follow ${describe(next)}`,
    });
  }

  // 3. Filter: GET form with a select.
  for (const form of forms.filter((f) => f.method === 'get' && f.classification !== 'search' && f.classification !== 'login' && f.classification !== 'signup')) {
    if (form.hasSensitiveFields) {
      skippedByPolicy += 1;
      continue;
    }
    const select = form.fieldElementIds.map((id) => byId.get(id)).find((e) => e && e.kind === 'select' && eligible(e, page));
    if (!select) continue;
    const submit = form.submitElementId ? byId.get(form.submitElementId) : undefined;
    push({
      kind: 'filter-change',
      pageUrl,
      element: select,
      form,
      action: { type: 'select-option', locator: preferredLocator(select.locators)! },
      allowedBecause: 'GET form select; changing it is a read',
      description: `change ${describe(select)}`,
      ...(submit && !submit.consequential ? { submitElement: submit } : {}),
    });
    break;
  }

  // 4. Tabs.
  const tab = elements.find((e) => e.kind === 'tab' && e.attributes.ariaSelected !== 'true' && eligible(e, page));
  if (tab) push({ kind: 'tab-change', pageUrl, element: tab, action: { type: 'click', locator: preferredLocator(tab.locators)! }, allowedBecause: 'tab switch is an in-page view change', description: `select ${describe(tab)}` });

  // 5. Menus and expanders.
  const popup = elements.find((e) => e.kind === 'button' && e.attributes.ariaHasPopup && e.attributes.ariaHasPopup !== 'false' && e.attributes.ariaHasPopup !== 'dialog' && eligible(e, page));
  if (popup) push({ kind: 'menu-open', pageUrl, element: popup, action: { type: 'click', locator: preferredLocator(popup.locators)! }, allowedBecause: 'button declares aria-haspopup; opening a menu is an in-page change', description: `open ${describe(popup)}` });

  const summary = elements.find((e) => e.kind === 'summary' && eligible(e, page));
  if (summary) push({ kind: 'accordion-expand', pageUrl, element: summary, action: { type: 'click', locator: preferredLocator(summary.locators)! }, allowedBecause: 'details/summary toggle is an in-page change', description: `expand ${describe(summary)}` });

  const expander = elements.find((e) => e.kind === 'button' && e.attributes.ariaExpanded === 'false' && !e.attributes.ariaHasPopup && e.elementId !== popup?.elementId && eligible(e, page));
  if (expander) push({ kind: 'expand-toggle', pageUrl, element: expander, action: { type: 'click', locator: preferredLocator(expander.locators)! }, allowedBecause: 'button declares aria-expanded=false; expanding is an in-page change', description: `expand ${describe(expander)}` });

  const dialogOpener = elements.find((e) => e.kind === 'button' && e.attributes.ariaHasPopup === 'dialog' && eligible(e, page));
  if (dialogOpener) push({ kind: 'dialog-open', pageUrl, element: dialogOpener, action: { type: 'click', locator: preferredLocator(dialogOpener.locators)! }, allowedBecause: 'button declares aria-haspopup=dialog; opening is an in-page change', description: `open ${describe(dialogOpener)}` });

  // 6. Write probes: only with the operator flag, and only POST forms that are searches or filters without sensitive fields.
  if (policy.allowWriteProbes) {
    for (const form of forms.filter((f) => f.method === 'post' && (f.classification === 'search' || f.classification === 'filter') && !f.hasSensitiveFields)) {
      const field = form.fieldElementIds.map((id) => byId.get(id)).find((e) => e && (e.kind === 'textbox' || e.kind === 'searchbox') && eligible(e, page));
      if (!field) continue;
      push({
        kind: 'form-submit-write',
        pageUrl,
        element: field,
        form,
        action: { type: 'fill-and-submit', locator: preferredLocator(field.locators)!, value: chooseQuery(page, elements) },
        allowedBecause: 'operator enabled write probes; POST form is a search or filter with no sensitive fields',
        description: `submit POST ${form.classification} form via ${describe(field)}`,
      });
      break;
    }
  } else {
    skippedByPolicy += forms.filter((f) => f.method === 'post').length;
  }

  return { probes, skippedByPolicy };
}

function isNextLikeRecord(e: ElementRecord): boolean {
  return isNextLink({ tag: e.tag, attrs: { rel: e.attributes.rel }, text: e.text, name: e.name } as Parameters<typeof isNextLink>[0]);
}

function toPageState(q: Awaited<ReturnType<typeof quickState>>): PageState {
  return { url: q.url, title: q.title || undefined, textLength: q.textLength, interactiveCount: q.interactiveCount, linkCount: q.linkCount, dialogCount: q.dialogCount, stateHash: q.stateHash, links: q.links };
}

/** Wait for a navigation or a DOM change after an action; returns what ended the wait. */
async function waitForChange(page: Page, before: PageState, timeoutMs: number): Promise<{ waitedFor: ProbeRecord['waitedFor']; after: PageState }> {
  const started = Date.now();
  let lastHash = before.stateHash;
  let changedAt: number | undefined;
  while (Date.now() - started < timeoutMs) {
    if (page.url() !== before.url) {
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
      await settle(page, Math.max(500, timeoutMs - (Date.now() - started)));
      return { waitedFor: 'navigation', after: toPageState(await quickState(page)) };
    }
    let q: Awaited<ReturnType<typeof quickState>> | undefined;
    try {
      q = await quickState(page);
    } catch {
      await page.waitForTimeout(100);
      continue;
    }
    if (q.stateHash !== before.stateHash) {
      if (q.stateHash === lastHash && changedAt !== undefined && Date.now() - changedAt >= 400) return { waitedFor: 'dom-stable', after: toPageState(q) };
      if (q.stateHash !== lastHash) changedAt = Date.now();
      lastHash = q.stateHash;
    }
    await page.waitForTimeout(150);
  }
  let final: PageState = before;
  try {
    final = toPageState(await quickState(page));
  } catch {
    // page may be mid-navigation; keep the last known state
  }
  return { waitedFor: final.stateHash === before.stateHash ? 'timeout' : 'dom-stable', after: final };
}

export async function executeProbe(runtime: BrowserRuntime, plan: ProbePlan, budget: ProbeBudget, scope: ScopePolicy, probeId: string, networkSink?: NetworkSink): Promise<ProbeRecord> {
  const started = Date.now();
  const record: ProbeRecord = {
    probeId,
    pageUrl: plan.pageUrl,
    kind: plan.kind,
    targetElementId: plan.element.elementId,
    targetDescription: plan.description,
    action: plan.action,
    allowedBecause: plan.allowedBecause,
    waitedFor: 'none',
    outcome: 'error',
    durationMs: 0,
    restored: true,
  };
  const { context, stats, close, setAppRequests } = await runtime.newContext({ pageUrl: plan.pageUrl, probeId });
  const overall = budget.pageLoadTimeoutMs + budget.settleTimeoutMs * 3 + 10_000;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe exceeded ${overall}ms`)), overall);
  });

  const run = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(budget.pageLoadTimeoutMs, 8_000));
    await gotoWithPolicy(page, plan.pageUrl, { timeout: budget.pageLoadTimeoutMs });
    await settle(page, budget.settleTimeoutMs);
    const before = toPageState(await quickState(page));
    record.before = before;

    // D27: the page may answer a search, filter or page change with its own requests; a toggle, tab, menu or dialog may not hide a write behind them.
    setAppRequests(plan.kind === 'search-submit' || plan.kind === 'filter-change' || plan.kind === 'pagination' || plan.kind === 'form-submit-write');
    const locator = toLocator(page, plan.action.locator);
    const count = await locator.count();
    if (count === 0) {
      record.outcome = 'error';
      record.error = 'target element not found at probe time (locator drift)';
      return;
    }
    const target = locator.first();

    switch (plan.action.type) {
      case 'fill-and-submit':
        await target.fill(plan.action.value ?? 'test');
        await target.press('Enter', { noWaitAfter: true });
        break;
      case 'click':
        await target.click({ noWaitAfter: true });
        break;
      case 'select-option': {
        const options = await target.locator('option').count();
        if (options < 2) {
          record.outcome = 'skipped';
          record.error = 'select has fewer than two options';
          return;
        }
        const label = await target.locator('option').nth(1).textContent();
        await target.selectOption({ index: 1 });
        record.action = { ...record.action, value: (label ?? '').trim().slice(0, 80) };
        break;
      }
    }

    let { waitedFor, after } = await waitForChange(page, before, budget.settleTimeoutMs);
    if (plan.kind === 'filter-change' && waitedFor === 'timeout' && plan.submitElement) {
      const submitLoc = preferredLocator(plan.submitElement.locators);
      if (submitLoc) {
        await toLocator(page, submitLoc).first().click({ noWaitAfter: true });
        ({ waitedFor, after } = await waitForChange(page, before, budget.settleTimeoutMs));
      }
    }
    record.waitedFor = waitedFor;
    record.after = after;

    const targetStateAfter: Record<string, string> = {};
    try {
      for (const attr of ['aria-expanded', 'aria-selected', 'aria-pressed', 'open']) {
        const v = await locator.first().getAttribute(attr, { timeout: 500 }).catch(() => null);
        if (v !== null) targetStateAfter[attr] = v;
      }
      if (plan.kind === 'accordion-expand') {
        const open = await locator.first().evaluate((el) => (el.closest('details') as HTMLDetailsElement | null)?.open ?? false).catch(() => false);
        targetStateAfter['details-open'] = String(open);
      }
    } catch {
      // detached after navigation
    }

    const urlChanged = after.url !== before.url;
    record.changes = {
      urlChanged,
      titleChanged: after.title !== before.title,
      textDelta: after.textLength - before.textLength,
      interactiveDelta: after.interactiveCount - before.interactiveCount,
      dialogOpened: after.dialogCount > before.dialogCount,
      ...(Object.keys(targetStateAfter).length ? { targetStateAfter } : {}),
    };
    if (urlChanged && !scope.isInScope(after.url)) {
      record.outcome = 'error';
      record.error = `navigated out of scope to ${after.url}`;
      return;
    }
    record.outcome = urlChanged ? 'navigated' : after.stateHash !== before.stateHash ? 'changed' : 'unchanged';
  };

  try {
    await Promise.race([run(), deadline]);
  } catch (err) {
    record.outcome = 'error';
    record.error = (err instanceof Error ? err.message : String(err)).split('\n')[0];
  } finally {
    if (timer) clearTimeout(timer);
    await close();
    if (networkSink && stats.network.length) await networkSink(stats.network).catch(() => {});
    record.durationMs = Date.now() - started;
  }
  return record;
}
