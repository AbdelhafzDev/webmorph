import type { Page } from 'playwright';
import type { ScopePolicy } from '../net/scope.js';
import type { ToolErrorCode, ToolSpec, ToolStep, Extractor } from '../schemas/toolDefinition.js';
import type { ToolRunResult } from '../schemas/validationReport.js';
import { gotoWithPolicy, type BrowserRuntime } from '../browser/runtime.js';
import { extractListData } from '../html/listData.js';
import { toLocator } from '../browser/locators.js';
import { settle } from '../browser/inspect.js';
import { evaluateInPage } from '../browser/evaluate.js';
import { detectBlockSignal } from '../html/blocked.js';
import { validateAgainstSchema } from './jsonschema.js';
import { extractPageData } from '../html/pageData.js';
import { shortHash } from '../core/ids.js';
import { SafeHttpClient } from '../net/http.js';
import type { Resolver } from '../net/ssrf.js';
import { sameSite, hostnameOf } from '../net/url.js';
import { credentialCovers, type ApiCredential } from '../schemas/siteConfig.js';

export interface ExecuteOptions {
  scope: ScopePolicy;
  pageLoadTimeoutMs: number;
  settleTimeoutMs: number;
  now?: () => Date;
  /** For http steps. User agent and private-network policy default to the scope's. */
  http?: { maxResponseBytes?: number; resolver?: Resolver };
  /**
   * Operator-configured credentials from the site config. An http step with a credentialRef
   * resolves it here at run time and fails with PERMISSION_DENIED when it is missing.
   */
  credentials?: readonly ApiCredential[];
}

export function toolNeedsBrowser(tool: ToolSpec): boolean {
  return tool.program.some((s) => s.op !== 'http' && !(s.op === 'extract' && (s.extractor.kind === 'json' || s.extractor.kind === 'html-data' || s.extractor.kind === 'html-list')));
}

class ToolFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Error code for a page whose title says it is an error page although the response was 200
 * ("Internal Server Error", "404 - Page not found"); undefined for any ordinary title.
 */
export function softErrorFromTitle(title: string): 'NOT_FOUND' | 'SITE_CHANGED' | undefined {
  const t = title.trim().toLowerCase().replace(/\s*[|\-–—:]\s*[^|\-–—:]{0,40}$/, '');
  const sep = String.raw`\s*[-|:–—]?\s*`;
  if (new RegExp(`^(?:(?:404|410)(?:${sep}(?:page\\s+|resource\\s+)?not\\s+found)?|(?:page\\s+|resource\\s+)?not\\s+found|page does not exist|page doesn'?t exist)$`).test(t)) return 'NOT_FOUND';
  if (new RegExp(`^(?:5\\d\\d(?:${sep}(?:internal\\s+)?server\\s+error)?|internal server error|server error|application error|an error (?:has )?occurred|something went wrong|error)$`).test(t)) return 'SITE_CHANGED';
  return undefined;
}

function renderUrl(step: { url: string; query?: Record<string, string>; fixedQuery?: Record<string, string> }, inputs: Record<string, unknown>): string {
  const url = step.url.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, name: string) => {
    const v = inputs[name];
    if (v === undefined || v === null) throw new ToolFailure('INPUT_INVALID', `missing input "${name}" for URL`);
    return encodeURIComponent(String(v));
  });
  const parsed = new URL(url);
  for (const [param, value] of Object.entries(step.fixedQuery ?? {})) parsed.searchParams.set(param, value);
  for (const [param, inputName] of Object.entries(step.query ?? {})) {
    const v = inputs[inputName];
    if (v !== undefined && v !== null && v !== '') parsed.searchParams.set(param, String(v));
  }
  return parsed.toString();
}

/** Fill {{input}} placeholders inside a JSON body template, escaping values as JSON string content. */
function renderBody(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, name: string) => {
    const v = inputs[name];
    if (v === undefined || v === null) throw new ToolFailure('INPUT_INVALID', `missing input "${name}" for request body`);
    return JSON.stringify(String(v)).slice(1, -1);
  });
}

/** Fill placeholders in a variables template and add optional variables whose inputs were provided. */
function renderGraphQLBody(g: NonNullable<Extract<ToolStep, { op: 'http' }>['graphql']>, inputs: Record<string, unknown>): string {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
      if (whole) {
        const x = inputs[whole[1]!];
        if (x === undefined || x === null) throw new ToolFailure('INPUT_INVALID', `missing input "${whole[1]}" for GraphQL variables`);
        return x;
      }
      return v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, name: string) => {
        const x = inputs[name];
        if (x === undefined || x === null) throw new ToolFailure('INPUT_INVALID', `missing input "${name}" for GraphQL variables`);
        return String(x);
      });
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const variables = fill(g.variables) as Record<string, unknown>;
  for (const [variable, inputName] of Object.entries(g.optionalVariables ?? {})) {
    const x = inputs[inputName];
    if (x !== undefined && x !== null && x !== '') variables[variable] = x;
  }
  return JSON.stringify({ operationName: g.operationName, query: g.query, variables });
}

/** Hosts an http program may call: the scope's hosts plus same-site API hosts named by its steps. */
function httpHostsFor(tool: ToolSpec, scope: ScopePolicy): string[] {
  const origin = hostnameOf(scope.data.origin);
  const extra = new Set<string>();
  for (const s of tool.program) {
    if (s.op !== 'http') continue;
    try {
      const host = hostnameOf(s.url.replace(/\{\{[^}]+\}\}/g, 'x'));
      if (!scope.isHostAllowed(host) && sameSite(host, origin)) extra.add(host);
    } catch {
      // unparseable template; the step will fail at run time
    }
  }
  return Array.from(extra);
}

/** Browser-side result choice: mark the chosen link so the caller can click exactly it. Self-contained. */
function pickResultInPage(arg: { hrefPattern: string; scope: 'main' | 'body'; allowedHosts: string[]; title?: string; index?: number }): { ok: true; title: string; url: string; candidates: number } | { ok: false; reason: string } {
  const re = new RegExp(arg.hrefPattern);
  const collect = (root: Element): HTMLAnchorElement[] => {
    const seen = new Set<string>();
    const out: HTMLAnchorElement[] = [];
    for (const a of Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      if (a.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"]')) continue;
      let u: URL;
      try {
        u = new URL(a.href);
      } catch {
        continue;
      }
      if (!arg.allowedHosts.includes(u.hostname.toLowerCase()) || !re.test(u.pathname)) continue;
      const key = `${u.pathname}${u.search}`;
      if (seen.has(key) || key === `${location.pathname}${location.search}`) continue;
      const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  };
  for (const el of Array.from(document.querySelectorAll('[data-webmorph-pick]'))) el.removeAttribute('data-webmorph-pick');
  let candidates = arg.scope === 'main' ? collect(document.querySelector('main, [role="main"]') ?? document.body) : collect(document.body);
  if (candidates.length === 0 && arg.scope === 'main') candidates = collect(document.body);
  if (candidates.length === 0) return { ok: false, reason: `no result links matching ${arg.hrefPattern} on ${location.pathname}` };
  const text = (a: HTMLAnchorElement) => (a.innerText || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  let chosen: HTMLAnchorElement | undefined;
  if (arg.title) {
    const needle = arg.title.toLowerCase();
    chosen = candidates.find((a) => text(a).toLowerCase() === needle) ?? candidates.find((a) => text(a).toLowerCase().includes(needle));
    if (!chosen) return { ok: false, reason: `no result titled "${arg.title}" among ${candidates.length} result(s)` };
  } else if (arg.index !== undefined) {
    chosen = candidates[arg.index - 1];
    if (!chosen) return { ok: false, reason: `result index ${arg.index} is out of range (${candidates.length} result(s))` };
  } else chosen = candidates[0]!;
  chosen.setAttribute('data-webmorph-pick', '1');
  return { ok: true, title: text(chosen), url: chosen.href, candidates: candidates.length };
}

/** Browser-side extraction. Self-contained for evaluateInPage. */
function extractLinkListInPage(arg: { scope: 'main' | 'body'; hrefPattern: string; excludeHrefPattern?: string; maxItems: number; allowedHosts: string[] }): Array<{ title: string; url: string }> {
  const root = (arg.scope === 'main' ? document.querySelector('main, [role="main"]') : null) ?? document.body;
  const re = new RegExp(arg.hrefPattern);
  const ex = arg.excludeHrefPattern ? new RegExp(arg.excludeHrefPattern) : null;
  const seen = new Set<string>();
  const self = `${location.pathname}${location.search}`;
  const out: Array<{ title: string; url: string }> = [];
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    // Site chrome is never a result.
    if (a.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [aria-label*="breadcrumb" i]')) continue;
    let u: URL;
    try {
      u = new URL((a as HTMLAnchorElement).href);
    } catch {
      continue;
    }
    if (!arg.allowedHosts.includes(u.hostname.toLowerCase()) || !re.test(u.pathname) || (ex && ex.test(u.pathname))) continue;
    if (`${u.pathname}${u.search}` === self) continue; // skip links, anchors and self references are not results
    const key = `${u.origin}${u.pathname}${u.search}`;
    if (seen.has(key)) continue;
    const title = ((a as HTMLElement).innerText || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 200), url: key });
    if (out.length >= arg.maxItems) break;
  }
  return out;
}

function extractPageFieldsInPage(arg: { fields: Record<string, { source: string; selector?: string; maxChars?: number }> }): Record<string, unknown> {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(arg.fields)) {
    let value: unknown;
    switch (f.source) {
      case 'title':
        value = clean(document.title);
        break;
      case 'h1':
        value = clean(document.querySelector('h1')?.textContent);
        break;
      case 'url':
        value = location.href;
        break;
      case 'meta-description':
        value = clean(document.querySelector('meta[name="description"]')?.getAttribute('content'));
        break;
      case 'main-text': {
        const root = (document.querySelector('main, [role="main"], article') as HTMLElement | null) ?? document.body;
        value = clean(root.innerText);
        break;
      }
      case 'json-ld-types': {
        const types = new Set<string>();
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          try {
            const parsed = JSON.parse(s.textContent ?? '') as unknown;
            const visit = (n: unknown): void => {
              if (!n || typeof n !== 'object') return;
              if (Array.isArray(n)) return n.forEach(visit);
              const t = (n as Record<string, unknown>)['@type'];
              if (typeof t === 'string') types.add(t);
              if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
              visit((n as Record<string, unknown>)['@graph']);
            };
            visit(parsed);
          } catch {
            // ignore malformed JSON-LD
          }
        }
        value = Array.from(types).sort();
        break;
      }
      case 'selector-text':
        value = f.selector ? clean(document.querySelector(f.selector)?.textContent) : '';
        break;
      default:
        value = '';
    }
    if (typeof value === 'string' && f.maxChars) value = value.slice(0, f.maxChars);
    out[name] = value;
  }
  return out;
}

/**
 * Execute a declarative tool program against the live site in a fresh browser
 * context. Never throws for expected failures; every outcome is a ToolRunResult
 * with an error code an agent can act on.
 */
export async function executeTool(runtime: BrowserRuntime | null, tool: ToolSpec, inputs: Record<string, unknown>, options: ExecuteOptions): Promise<ToolRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const started = Date.now();
  const steps: ToolRunResult['steps'] = [];
  const output: Record<string, unknown> = {};
  const runId = `run-${shortHash(`${tool.toolId}|${startedAt.toISOString()}|${JSON.stringify(inputs)}`, 10)}`;
  const finish = (ok: boolean, extra: Partial<ToolRunResult> = {}): ToolRunResult => ({
    runId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    ok,
    steps,
    ...extra,
  });

  const problems = validateAgainstSchema(tool.inputSchema, inputs);
  if (problems.length) return finish(false, { errorCode: 'INPUT_INVALID', errorMessage: problems.map((p) => `${p.path} ${p.message}`).join('; ') });

  const needsBrowser = toolNeedsBrowser(tool);
  if (needsBrowser && !runtime) return finish(false, { errorCode: 'RUNTIME_ERROR', errorMessage: 'tool needs a browser but none is available' });
  const ctx = needsBrowser ? await runtime!.newContext({ pageUrl: tool.name }) : undefined;
  const httpScope = tool.program.some((s) => s.op === 'http') ? options.scope.withHosts(httpHostsFor(tool, options.scope)) : options.scope;
  const http = tool.program.some((s) => s.op === 'http')
    ? new SafeHttpClient({ scope: httpScope, allowPrivate: options.scope.data.allowPrivateNetwork, userAgent: options.scope.data.userAgent, requestTimeoutMs: options.pageLoadTimeoutMs, maxResponseBytes: options.http?.maxResponseBytes ?? 5 * 1024 * 1024, maxRedirects: 5, maxRetries: 1, minDelayMs: 0, maxConcurrency: 2, maxRequests: 50, resolver: options.http?.resolver })
    : undefined;
  let page: Page | undefined;
  let lastUrl = '';
  try {
    if (ctx) {
      page = await ctx.context.newPage();
      page.setDefaultTimeout(Math.min(options.pageLoadTimeoutMs, 10_000));
    }
    const state: StepState = { urlBeforeAction: undefined, http, httpScope };
    for (const step of tool.program) {
      const stepStarted = Date.now();
      try {
        await runStep(page, step, inputs, output, options, state);
        steps.push({ op: step.op, status: 'ok', durationMs: Date.now() - stepStarted });
        if (state.lastHttp) lastUrl = state.lastHttp.url;
      } catch (err) {
        const failure = err instanceof ToolFailure ? err : classifyError(err);
        steps.push({ op: step.op, status: 'failed', durationMs: Date.now() - stepStarted, detail: failure.message });
        for (const rest of tool.program.slice(steps.length)) steps.push({ op: rest.op, status: 'skipped', durationMs: 0 });
        return finish(false, { errorCode: failure.code, errorMessage: failure.message, finalUrl: page?.url() ?? lastUrl });
      }
      if (page) lastUrl = page.url();
    }
    const outProblems = validateAgainstSchema(tool.outputSchema, output);
    if (outProblems.length) {
      return finish(false, { errorCode: 'OUTPUT_INVALID', errorMessage: outProblems.map((p) => `${p.path} ${p.message}`).join('; '), output, finalUrl: lastUrl });
    }
    return finish(true, { output, finalUrl: lastUrl });
  } catch (err) {
    const failure = classifyError(err);
    return finish(false, { errorCode: failure.code, errorMessage: failure.message, finalUrl: page?.url() });
  } finally {
    await ctx?.close();
    await http?.close();
  }
}

interface StepState {
  /** URL at the moment the last action (fill, select, click, press) started; what a navigation wait compares against. */
  urlBeforeAction: string | undefined;
  http?: SafeHttpClient;
  httpScope?: ScopePolicy;
  lastHttp?: { url: string; status: number; contentType?: string; body: string };
}

async function runStep(page: Page | undefined, step: ToolStep, inputs: Record<string, unknown>, output: Record<string, unknown>, options: ExecuteOptions, state: StepState): Promise<void> {
  if (step.op === 'http') {
    const url = renderUrl(step, inputs);
    if (!(state.httpScope ?? options.scope).isInScope(url)) throw new ToolFailure('OUT_OF_SCOPE', `refusing to request ${url}`);
    // A configured credential is resolved by name at run time and sent only to the host it was configured for.
    let headers: Record<string, string> | undefined;
    if (step.credentialRef) {
      const credential = options.credentials?.find((c) => c.name === step.credentialRef);
      if (!credential) throw new ToolFailure('PERMISSION_DENIED', `credential "${step.credentialRef}" is not configured for this site; add it with "webmorph credentials set"`);
      const target = new URL(url);
      if (!credentialCovers(credential, target, credential.header)) throw new ToolFailure('PERMISSION_DENIED', `credential "${credential.name}" is configured for ${credential.host}, not ${target.host}`);
      headers = { [credential.header]: credential.value };
    }
    const body = step.method === 'POST' ? (step.graphql ? renderGraphQLBody(step.graphql, inputs) : step.body !== undefined ? renderBody(step.body, inputs) : undefined) : undefined;
    const res = await state.http!.fetch(url, { method: step.method, ...(body !== undefined ? { body, contentType: step.contentType ?? 'application/json' } : {}), accept: step.accept ?? 'application/json', acceptTypes: /json|text|xml/i, ...(headers ? { headers } : {}) });
    if (!res.ok) {
      if (res.kind === 'out-of-scope' || res.kind === 'ssrf-blocked' || res.kind === 'prohibited') throw new ToolFailure('OUT_OF_SCOPE', res.message);
      if (res.kind === 'timeout') throw new ToolFailure('TIMEOUT', res.message);
      throw new ToolFailure('SITE_CHANGED', res.message);
    }
    if (res.status === 404 || res.status === 410) throw new ToolFailure('NOT_FOUND', `HTTP ${res.status} for ${url}`);
    if (res.status === 401 || res.status === 403) throw new ToolFailure('PERMISSION_DENIED', step.credentialRef ? `HTTP ${res.status}: the endpoint refused the configured credential "${step.credentialRef}"` : `HTTP ${res.status}: the endpoint requires credentials`);
    if (res.status >= 400) {
      const signal = detectBlockSignal(res.status, res.headers, res.body.toString('utf8', 0, 20_000));
      throw new ToolFailure(signal ? 'BLOCKED' : 'SITE_CHANGED', `${signal ?? 'HTTP error'} (HTTP ${res.status})`);
    }
    state.lastHttp = { url: res.finalUrl, status: res.status, contentType: res.contentType, body: res.bodySkipped ? '' : res.body.toString('utf8') };
    return;
  }
  if (step.op === 'extract' && step.extractor.kind === 'html-data') {
    const last = state.lastHttp;
    if (!last) throw new ToolFailure('RUNTIME_ERROR', 'html-data extraction without a preceding http step');
    const data = extractPageData(last.body, { jsonLd: step.extractor.jsonLd, meta: step.extractor.meta, embeddedJson: step.extractor.embeddedJson });
    const soft = data.title ? softErrorFromTitle(data.title) : undefined;
    if (soft) throw new ToolFailure(soft, `page title "${data.title}" is an error page`);
    Object.assign(output, { url: last.url, status: last.status, title: data.title ?? '', description: data.description ?? '', canonical: data.canonical ?? '', og: data.og, jsonLd: data.jsonLd, jsonLdTypes: data.jsonLdTypes, breadcrumbs: data.breadcrumbs, embedded: data.embedded });
    return;
  }
  if (step.op === 'extract' && step.extractor.kind === 'html-list') {
    const last = state.lastHttp;
    if (!last) throw new ToolFailure('RUNTIME_ERROR', 'html-list extraction without a preceding http step');
    const data = extractListData(last.body, {
      pageUrl: last.url,
      hrefPattern: step.extractor.hrefPattern,
      ...(step.extractor.excludeHrefPattern ? { excludeHrefPattern: step.extractor.excludeHrefPattern } : {}),
      maxItems: step.extractor.maxItems,
      allowedHosts: Array.from((state.httpScope ?? options.scope).allowedHosts),
    });
    const title = extractPageData(last.body, { jsonLd: false, meta: false, embeddedJson: false }).title;
    const soft = title ? softErrorFromTitle(title) : undefined;
    if (soft) throw new ToolFailure(soft, `page title "${title}" is an error page`);
    output[step.extractor.into] = data.results;
    output['count'] = data.count;
    output['pageUrl'] = last.url;
    output['status'] = last.status;
    return;
  }
  if (step.op === 'extract' && step.extractor.kind === 'json') {
    const last = state.lastHttp;
    if (!last) throw new ToolFailure('RUNTIME_ERROR', 'json extraction without a preceding http step');
    let parsed: unknown;
    try {
      parsed = JSON.parse(last.body);
    } catch {
      throw new ToolFailure('OUTPUT_INVALID', `response from ${last.url} is not JSON${last.contentType ? ` (${last.contentType})` : ''}`);
    }
    if (parsed === null || typeof parsed !== 'object') throw new ToolFailure('OUTPUT_INVALID', 'JSON response is not an object or array');
    output[step.extractor.into] = parsed;
    output['status'] = last.status;
    output['url'] = last.url;
    return;
  }
  if (!page) throw new ToolFailure('RUNTIME_ERROR', `step ${step.op} needs a browser page`);
  switch (step.op) {
    case 'navigate': {
      state.urlBeforeAction = undefined;
      const url = renderUrl(step, inputs);
      if (!options.scope.isInScope(url)) throw new ToolFailure('OUT_OF_SCOPE', `refusing to open ${url}`);
      let response;
      try {
        ({ response } = await gotoWithPolicy(page, url, { timeout: options.pageLoadTimeoutMs }));
      } catch (err) {
        throw classifyError(err);
      }
      if (!options.scope.isInScope(page.url())) throw new ToolFailure('OUT_OF_SCOPE', `landed on ${page.url()}`);
      const status = response?.status();
      if (status !== undefined && status >= 400) {
        const body = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 20000)).catch(() => '');
        const signal = detectBlockSignal(status, response?.headers() ?? {}, body);
        if (signal) throw new ToolFailure('BLOCKED', `${signal} (HTTP ${status})`);
        if (status === 404 || status === 410) throw new ToolFailure('NOT_FOUND', `HTTP ${status} for ${url}`);
        throw new ToolFailure('SITE_CHANGED', `HTTP ${status} for ${url}`);
      }
      return;
    }
    case 'fill':
    case 'select':
    case 'click':
    case 'press': {
      const locator = toLocator(page, step.locator);
      if ((await locator.count()) === 0) throw new ToolFailure('LOCATOR_MISSING', `${step.locator.strategy} ${step.locator.value} not found`);
      const target = locator.first();
      state.urlBeforeAction = page.url();
      if (step.op === 'fill') await target.fill(String(inputs[step.valueFrom] ?? ''));
      else if (step.op === 'select') await target.selectOption(String(inputs[step.valueFrom] ?? ''));
      else if (step.op === 'click') await target.click({ noWaitAfter: true });
      else await target.press(step.key, { noWaitAfter: true });
      return;
    }
    case 'click-result': {
      const allowedHosts = Array.from(options.scope.allowedHosts);
      const title = step.titleFrom ? inputs[step.titleFrom] : undefined;
      const index = step.indexFrom ? inputs[step.indexFrom] : undefined;
      const picked = await evaluateInPage(page, pickResultInPage, { hrefPattern: step.hrefPattern, scope: step.scope, allowedHosts, title: typeof title === 'string' && title.trim() ? title.trim() : undefined, index: typeof index === 'number' ? index : undefined });
      if (!picked.ok) throw new ToolFailure('LOCATOR_MISSING', picked.reason);
      state.urlBeforeAction = page.url();
      await page.locator('[data-webmorph-pick="1"]').first().click({ noWaitAfter: true });
      return;
    }
    case 'wait': {
      if (step.for === 'navigation') {
        const before = state.urlBeforeAction ?? page.url();
        const deadline = Date.now() + step.timeoutMs;
        while (page.url() === before && Date.now() < deadline) await page.waitForTimeout(100);
        if (page.url() === before) throw new ToolFailure('SITE_CHANGED', 'expected a navigation that did not happen');
        await page.waitForLoadState('domcontentloaded', { timeout: step.timeoutMs }).catch(() => {});
        await settle(page, Math.min(step.timeoutMs, options.settleTimeoutMs));
      } else if (step.for === 'dom-stable') {
        await settle(page, step.timeoutMs);
      } else if (step.selector) {
        await page.locator(step.selector).first().waitFor({ state: 'attached', timeout: step.timeoutMs }).catch(() => {
          throw new ToolFailure('SITE_CHANGED', `selector ${step.selector} did not appear`);
        });
      }
      return;
    }
    case 'assert': {
      if (step.check === 'url-matches') {
        if (!new RegExp(step.value ?? '').test(page.url())) throw new ToolFailure('SITE_CHANGED', `url ${page.url()} does not match ${step.value}`);
      } else if (step.check === 'selector-present') {
        if ((await page.locator(step.value ?? 'body').count()) === 0) throw new ToolFailure('SITE_CHANGED', `selector ${step.value} missing`);
      } else if (step.check === 'title-not-empty') {
        const title = (await page.title()).trim();
        if (!title) throw new ToolFailure('SITE_CHANGED', 'page title is empty');
        // Sites that answer 200 with an error page: the title is the only signal left.
        const soft = softErrorFromTitle(title);
        if (soft) throw new ToolFailure(soft, `page title "${title}" is an error page`);
      }
      return;
    }
    case 'extract': {
      const ex: Extractor = step.extractor;
      if (ex.kind === 'json' || ex.kind === 'html-data' || ex.kind === 'html-list') return;
      if (ex.kind === 'link-list') {
        const results = await evaluateInPage(page, extractLinkListInPage, { scope: ex.scope, hrefPattern: ex.hrefPattern, excludeHrefPattern: ex.excludeHrefPattern, maxItems: ex.maxItems, allowedHosts: Array.from(options.scope.allowedHosts) });
        output[ex.into] = results;
        output['count'] = results.length;
        output['pageUrl'] = page.url();
      } else {
        const fields = await evaluateInPage(page, extractPageFieldsInPage, { fields: ex.fields });
        Object.assign(output, fields);
      }
      return;
    }
  }
}

function classifyError(err: unknown): ToolFailure {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unknown error';
  if (err instanceof ToolFailure) return err;
  if (/Timeout/i.test(message)) return new ToolFailure('TIMEOUT', message);
  if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return new ToolFailure('OUT_OF_SCOPE', 'navigation refused by scope or SSRF policy');
  if (/ERR_TOO_MANY_REDIRECTS/.test(message)) return new ToolFailure('SITE_CHANGED', 'redirect loop');
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/.test(message)) return new ToolFailure('SITE_CHANGED', message);
  return new ToolFailure('RUNTIME_ERROR', message);
}
