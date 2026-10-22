import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response, type Route } from 'playwright';
import type { ScopePolicy } from '../net/scope.js';
import { assertPublicHost, isBlockedHostname, type Resolver } from '../net/ssrf.js';
import { PolicyProxy } from './proxy.js';
import type { NetworkRecord } from '../schemas/networkEvidence.js';
import { cookieNames, credentialHeaderNames, isCredentialed, keysOfJson, redactUrl, shapeOfJson } from '../net/redact.js';
import { isGraphQLReadOnly, parseGraphQLRequest } from '../net/graphql.js';
import { hostnameOf, sameSite } from '../net/url.js';

export interface RuntimeOptions {
  scope: ScopePolicy;
  allowPrivate: boolean;
  userAgent: string;
  headed?: boolean;
  /** Abort images, media and fonts. Default true. */
  blockHeavyResources?: boolean;
  /** Permit non-GET requests to in-scope hosts (operator opted into write probes). Default false. */
  allowWrites?: boolean;
  /**
   * Refuse every non-GET request, including the page's own XHR and fetch calls (pre-D27 behavior).
   * Default false: a page's own non-GET XHR/fetch to the site's hosts is allowed and recorded as an
   * app request, because WebMorph's actions stay read-only by construction and a single-page app
   * cannot render without them.
   */
  strictMethods?: boolean;
  /** Redirect hops followed per request. Default 5. */
  maxRedirects?: number;
  executablePath?: string;
  channel?: string;
  resolver?: Resolver;
  viewport?: { width: number; height: number };
  /** Record XHR, fetch and document traffic (redacted) as evidence. Default true. */
  captureNetwork?: boolean;
  maxNetworkRecords?: number;
  maxJsonPeekBytes?: number;
  now?: () => Date;
}

export interface ContextTag {
  pageUrl: string;
  probeId?: string;
}

export interface ContextOptions {
  /** Hosts whose documents are in scope for this context only (same-site hosts a tool or the harness names). */
  extraHosts?: string[];
}

export interface ContextStats {
  blockedRequests: number;
  blockedUrls: string[];
  blockedWrites: number;
  /** Non-GET XHR/fetch requests the page issued to the site's own hosts and that were allowed (D27). */
  appRequests: number;
  graphqlQueries: number;
  blockedWebSockets: number;
  refusedRedirects: Array<{ from: string; to: string; reason: string }>;
  failedRequests: Array<{ url: string; reason: string }>;
  consoleErrors: string[];
  network: NetworkRecord[];
  networkTruncated: boolean;
  tag: ContextTag;
  /** Scope for this context when it widens the runtime's (extra same-site hosts). */
  scope?: ScopePolicy;
  /** D27: whether the page's own non-GET requests are allowed right now. True on load and after read-query actions; an actor turns it off before a toggle-style action. */
  appRequestsAllowed: boolean;
}

export interface IsolatedContext {
  context: BrowserContext;
  stats: ContextStats;
  /** Allow or refuse the page's own non-GET requests from now on (D27). */
  setAppRequests(allowed: boolean): void;
  close(): Promise<void>;
}

/** Header on a synthetic document response that hands a redirect back to the navigator. */
export const REDIRECT_HANDOFF_HEADER = 'x-webmorph-redirect';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']);

/**
 * Owns the Playwright browser and hands out isolated contexts with the discovery
 * policy enforced twice: at the connection level by a local proxy that resolves
 * and pins every host (so redirect hops, WebSockets and DNS rebinding cannot
 * escape), and at the request level by a route handler that applies document
 * scope, method policy, resource blocking and per-hop redirect checks.
 */
export class BrowserRuntime {
  private browser?: Browser;
  private proxy?: PolicyProxy;
  private readonly hostVerdicts = new Map<string, Promise<boolean>>();

  constructor(private readonly options: RuntimeOptions) {}

  async launch(): Promise<void> {
    if (this.browser) return;
    this.proxy = new PolicyProxy({
      allowPrivate: this.options.allowPrivate,
      resolver: this.options.resolver,
      isHostAllowed: () => true, // document scope is decided at the route layer; the proxy enforces SSRF for every host
    });
    const server = await this.proxy.start();
    this.browser = await chromium.launch({
      headless: !this.options.headed,
      proxy: { server, bypass: '<-loopback>' },
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.channel ? { channel: this.options.channel } : {}),
    });
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    await b?.close();
    await this.proxy?.close();
    this.proxy = undefined;
  }

  get proxyRefusals() {
    return this.proxy?.refusals ?? [];
  }

  async newContext(tag: ContextTag = { pageUrl: 'about:blank' }, options: ContextOptions = {}): Promise<IsolatedContext> {
    if (!this.browser) throw new Error('BrowserRuntime.launch() must be called first');
    const stats: ContextStats = { blockedRequests: 0, blockedUrls: [], blockedWrites: 0, appRequests: 0, graphqlQueries: 0, blockedWebSockets: 0, refusedRedirects: [], failedRequests: [], consoleErrors: [], network: [], networkTruncated: false, tag, appRequestsAllowed: true, ...(options.extraHosts?.length ? { scope: this.options.scope.withHosts(options.extraHosts) } : {}) };
    const context = await this.browser.newContext({
      userAgent: this.options.userAgent,
      viewport: this.options.viewport ?? { width: 1280, height: 900 },
      locale: 'en-US',
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
    });

    await context.route('**/*', (route) => this.handleRoute(route, stats));
    await context.routeWebSocket('**/*', (ws) => {
      stats.blockedWebSockets += 1;
      ws.close({ code: 1008, reason: 'websockets are not permitted during discovery' });
    });

    context.on('page', (page) => {
      page.on('console', (msg) => {
        if (msg.type() === 'error' && stats.consoleErrors.length < 50) stats.consoleErrors.push(msg.text().slice(0, 300));
      });
      page.on('pageerror', (err) => {
        if (stats.consoleErrors.length < 50) stats.consoleErrors.push(`pageerror: ${err.message.slice(0, 300)}`);
      });
      page.on('requestfailed', (req) => {
        const reason = req.failure()?.errorText ?? 'unknown';
        if (reason.includes('BLOCKED_BY_CLIENT')) return;
        if (stats.failedRequests.length < 50) stats.failedRequests.push({ url: req.url(), reason });
      });
    });

    return { context, stats, setAppRequests: (allowed) => { stats.appRequestsAllowed = allowed; }, close: () => context.close().catch(() => {}) };
  }

  private async handleRoute(route: Route, stats: ContextStats): Promise<void> {
    const request = route.request();
    const block = async (url: string) => {
      stats.blockedRequests += 1;
      if (stats.blockedUrls.length < 50) stats.blockedUrls.push(url);
      await route.abort('blockedbyclient').catch(() => {});
    };

    const graphql = request.method().toUpperCase() === 'POST' ? parseGraphQLRequest(request.headers()['content-type'], request.postData()) : null;
    const readOnlyGraphQL = isGraphQLReadOnly(graphql);
    if (readOnlyGraphQL) stats.graphqlQueries += 1;
    const method = readOnlyGraphQL ? 'GET' : request.method();
    // A GraphQL mutation or subscription is a write whatever D27 says about app requests; so is any non-GET while the actor has turned app requests off.
    const graphqlWrite = Boolean(graphql) && !readOnlyGraphQL;
    const decision = graphqlWrite || (!stats.appRequestsAllowed && !SAFE_METHODS.has(method.toUpperCase())) ? (this.options.allowWrites && (stats.scope ?? this.options.scope).isInScope(request.url()) && !graphqlWrite ? 'allow' : 'write') : await this.decide(request.url(), request.resourceType(), method, stats.scope);
    if (decision !== 'allow') {
      if (decision === 'write') stats.blockedWrites += 1;
      await this.record(stats, request, undefined, `refused: ${decision}`);
      await block(request.url());
      return;
    }
    // A non-GET the policy let through is the page's own app request (D27); say so in the evidence.
    const allowedAs = SAFE_METHODS.has(method.toUpperCase()) ? undefined : ('app-request' as const);
    if (allowedAs) stats.appRequests += 1;

    // Fetch ourselves with redirects disabled so every hop is checked.
    let response: Awaited<ReturnType<Route['fetch']>>;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (err) {
      stats.failedRequests.push({ url: request.url(), reason: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'fetch failed' });
      await route.abort('failed').catch(() => {});
      return;
    }

    const isDocument = request.resourceType() === 'document';
    let hops = 0;
    let current = request.url();
    for (;;) {
      const status = response.status();
      const location = response.headers()['location'];
      if (!(status >= 300 && status < 400 && location)) break;
      let target: string;
      try {
        target = new URL(location, current).toString();
      } catch {
        await block(current);
        return;
      }
      hops += 1;
      const verdict = await this.decide(target, request.resourceType(), 'GET', stats.scope);
      if (verdict !== 'allow' || hops > (this.options.maxRedirects ?? 5)) {
        stats.refusedRedirects.push({ from: current, to: target, reason: verdict !== 'allow' ? verdict : 'too many redirects' });
        await block(target);
        return;
      }
      if (isDocument) {
        // Hand the hop back: the navigator issues a real, routed navigation to the target.
        await route.fulfill({ status: 200, contentType: 'text/html', headers: { [REDIRECT_HANDOFF_HEADER]: target, 'cache-control': 'no-store' }, body: '<!doctype html><title>redirect</title>' }).catch(() => {});
        return;
      }
      try {
        response = await route.fetch({ url: target, maxRedirects: 0 });
      } catch (err) {
        stats.failedRequests.push({ url: target, reason: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'fetch failed' });
        await route.abort('failed').catch(() => {});
        return;
      }
      current = target;
    }

    await this.record(stats, request, response, undefined, current, allowedAs);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers())) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    await route.fulfill({ response, headers }).catch(() => {});
  }

  /** Evidence record for XHR, fetch and document traffic. Bodies are never stored; shapes are. */
  private async record(stats: ContextStats, request: Request, response: Awaited<ReturnType<Route['fetch']>> | undefined, error: string | undefined, finalUrl?: string, allowedAs?: 'app-request'): Promise<void> {
    if (this.options.captureNetwork === false) return;
    const type = request.resourceType();
    if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
    if (stats.network.length >= (this.options.maxNetworkRecords ?? 500)) {
      stats.networkTruncated = true;
      return;
    }
    let requestHeaders: Record<string, string> = {};
    try {
      requestHeaders = await request.allHeaders();
    } catch {
      requestHeaders = request.headers();
    }
    const url = redactUrl(finalUrl ?? request.url());
    const responseHeaders = response?.headers() ?? {};
    const responseType = responseHeaders['content-type'];
    let responseShape: NetworkRecord['responseShape'];
    let bytes: number | undefined;
    if (response && /json/i.test(responseType ?? '')) {
      try {
        const body = await response.body();
        bytes = body.length;
        if (body.length <= (this.options.maxJsonPeekBytes ?? 262_144)) responseShape = shapeOfJson(body.toString('utf8'));
      } catch {
        // body unavailable
      }
    } else if (responseHeaders['content-length']) bytes = Number(responseHeaders['content-length']) || undefined;
    const requestType = requestHeaders['content-type'];
    const requestBodyKeys = /json/i.test(requestType ?? '') ? keysOfJson(request.postData()) : undefined;
    const graphql = request.method().toUpperCase() === 'POST' ? parseGraphQLRequest(requestType, request.postData()) : null;
    const record: NetworkRecord = {
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      context: { pageUrl: stats.tag.pageUrl, ...(stats.tag.probeId ? { probeId: stats.tag.probeId } : {}) },
      resourceType: type,
      method: request.method().toUpperCase(),
      url,
      ...(response ? { status: response.status() } : {}),
      ...(requestType ? { requestContentType: requestType } : {}),
      ...(responseType ? { responseContentType: responseType } : {}),
      credentialed: isCredentialed(requestHeaders),
      ...(credentialHeaderNames(requestHeaders).length ? { credentialHeaders: credentialHeaderNames(requestHeaders) } : {}),
      ...(cookieNames(requestHeaders).length ? { cookieNames: cookieNames(requestHeaders) } : {}),
      ...(requestBodyKeys ? { requestBodyKeys } : {}),
      ...(responseShape ? { responseShape } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      inScope: (stats.scope ?? this.options.scope).isInScope(url),
      ...(error ? { error } : {}),
      ...(allowedAs ? { allowedAs } : {}),
      ...(graphql ? { graphql } : {}),
    };
    stats.network.push(record);
  }

  /**
   * Policy decision for one URL. Never throws. `scope` widens the runtime's scope for one context.
   * Non-GET: refused, except (a) writes the operator allowed to in-scope hosts, and (b) under D27 the
   * page's own XHR/fetch requests to in-scope or same-site hosts, which a browser would send anyway and
   * without which a single-page app renders nothing; those are recorded as app requests and never promoted.
   */
  async decide(rawUrl: string, resourceType: string, method: string, scope: ScopePolicy = this.options.scope): Promise<'allow' | 'scheme' | 'heavy' | 'scope' | 'prohibited' | 'blocked-host' | 'private' | 'write'> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return 'scheme';
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return 'allow';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
    if (this.options.blockHeavyResources !== false && (resourceType === 'image' || resourceType === 'media' || resourceType === 'font')) return 'heavy';
    const inScope = scope.isInScope(url.toString());
    if (resourceType === 'document' && !inScope) return 'scope';
    if (inScope && scope.isProhibitedPath(url.toString())) return 'prohibited';
    if (!SAFE_METHODS.has(method.toUpperCase())) {
      const appRequest = !this.options.strictMethods && (resourceType === 'xhr' || resourceType === 'fetch') && (inScope || sameSite(url.hostname, hostnameOf(scope.data.origin)));
      if (!appRequest && !(this.options.allowWrites && inScope)) return 'write';
    }
    if (!this.options.allowPrivate) {
      if (isBlockedHostname(url.hostname)) return 'blocked-host';
      if (!(await this.hostIsPublic(url.hostname))) return 'private';
    }
    return 'allow';
  }

  /** Compatibility wrapper used by older call sites. */
  async allow(request: Request): Promise<boolean> {
    return (await this.decide(request.url(), request.resourceType(), request.method())) === 'allow';
  }

  private hostIsPublic(host: string): Promise<boolean> {
    let verdict = this.hostVerdicts.get(host);
    if (!verdict) {
      verdict = assertPublicHost(host, { allowPrivate: false, resolver: this.options.resolver }).then(
        () => true,
        () => false,
      );
      this.hostVerdicts.set(host, verdict);
      // Re-check later: a rebinding name must not keep a stale "public" verdict.
      setTimeout(() => this.hostVerdicts.delete(host), 30_000).unref();
    }
    return verdict;
  }
}

export interface NavigateResult {
  response: Response | null;
  finalUrl: string;
  redirectChain: string[];
}

/**
 * Navigate with every redirect hop policed. Document redirects are handed back
 * by the route layer as synthetic responses, and this helper re-issues them as
 * real navigations so the page URL, cookies and relative links stay truthful.
 */
export async function gotoWithPolicy(page: Page, url: string, options: { timeout: number; maxRedirects?: number }): Promise<NavigateResult> {
  const chain: string[] = [];
  let current = url;
  for (;;) {
    const response = await page.goto(current, { waitUntil: 'domcontentloaded', timeout: options.timeout });
    const handoff = response?.headers()[REDIRECT_HANDOFF_HEADER];
    if (!handoff) return { response, finalUrl: page.url(), redirectChain: chain };
    chain.push(current);
    if (chain.length > (options.maxRedirects ?? 5)) throw new Error(`net::ERR_TOO_MANY_REDIRECTS at ${current}`);
    current = handoff;
  }
}
