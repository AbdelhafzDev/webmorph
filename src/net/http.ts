import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { gunzipSync } from 'node:zlib';
import { SsrfBlockedError, errorMessage } from '../core/errors.js';
import type { ScopePolicy } from './scope.js';
import { HostPacer, Semaphore } from './ratelimit.js';
import { makePinnedLookup, isBlockedHostname, type Resolver } from './ssrf.js';
import { normalizeUrl, hostnameOf, FETCH_NORMALIZE } from './url.js';

export interface SafeHttpClientOptions {
  scope: ScopePolicy;
  allowPrivate: boolean;
  userAgent: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxRetries: number;
  minDelayMs: number;
  maxConcurrency: number;
  maxRequests: number;
  resolver?: Resolver;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface FetchSuccess {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType?: string;
  body: Buffer;
  bodySkipped: boolean;
  redirectChain: RedirectHop[];
  durationMs: number;
  attempts: number;
}

export type FetchFailureKind =
  | 'out-of-scope'
  | 'ssrf-blocked'
  | 'too-many-redirects'
  | 'timeout'
  | 'network'
  | 'too-large'
  | 'budget-exhausted'
  | 'prohibited';

export interface FetchFailure {
  ok: false;
  requestedUrl: string;
  kind: FetchFailureKind;
  message: string;
  redirectChain: RedirectHop[];
  durationMs: number;
  attempts: number;
  /** Set when the failure is a redirect that left scope: the destination that was refused. */
  refusedUrl?: string;
}

export type FetchOutcome = FetchSuccess | FetchFailure;

export interface FetchRequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  accept?: string;
  /** Content types worth downloading. When set and the response does not match, the body is skipped. */
  acceptTypes?: RegExp;
  /**
   * Extra request headers, for an operator-configured credential. Sent only to the origin of the
   * requested URL: a redirect to another host, port or scheme continues without them.
   */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * HTTP client with the discovery pipeline's safety rules built in: scope and
 * SSRF checks on every hop, pinned DNS, size and time caps, politeness delay,
 * bounded retries, and a global request budget. Expected failures are returned,
 * not thrown.
 */
export class SafeHttpClient {
  private readonly dispatcher: Dispatcher;
  private readonly semaphore: Semaphore;
  private readonly pacer: HostPacer;
  private readonly sleep: (ms: number) => Promise<void>;
  private _requestsMade = 0;

  constructor(private readonly options: SafeHttpClientOptions) {
    this.dispatcher = new Agent({
      connect: {
        lookup: makePinnedLookup({ allowPrivate: options.allowPrivate, resolver: options.resolver }),
        timeout: options.requestTimeoutMs,
      },
      headersTimeout: options.requestTimeoutMs,
      bodyTimeout: options.requestTimeoutMs,
    });
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pacer = new HostPacer(options.minDelayMs, () => Date.now(), this.sleep);
  }

  get requestsMade(): number {
    return this._requestsMade;
  }

  get budgetRemaining(): number {
    return Math.max(0, this.options.maxRequests - this._requestsMade);
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async fetch(url: string, reqOptions: FetchRequestOptions = {}): Promise<FetchOutcome> {
    const started = Date.now();
    const chain: RedirectHop[] = [];
    let attempts = 0;
    const fail = (kind: FetchFailureKind, message: string, refusedUrl?: string): FetchFailure => ({
      ok: false,
      requestedUrl: url,
      kind,
      message,
      redirectChain: chain,
      durationMs: Date.now() - started,
      attempts,
      ...(refusedUrl ? { refusedUrl } : {}),
    });

    let current = normalizeUrl(url, undefined, FETCH_NORMALIZE);
    if (!current) return fail('out-of-scope', `Not an absolute http(s) URL: ${url}`);
    const extraHeaders = reqOptions.headers ? Object.fromEntries(Object.entries(reqOptions.headers).map(([k, v]) => [k.toLowerCase(), v])) : undefined;
    const extraHeadersOrigin = extraHeaders ? new URL(current).origin : undefined;

    for (let hop = 0; ; hop += 1) {
      const scopeCheck = this.checkTarget(current);
      if (scopeCheck) return fail(scopeCheck.kind, scopeCheck.message, hop > 0 ? current : undefined);

      if (this._requestsMade >= this.options.maxRequests) {
        return fail('budget-exhausted', `Request budget of ${this.options.maxRequests} exhausted`);
      }

      const release = await this.semaphore.acquire();
      let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
      let lastError: unknown;
      try {
        for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
          if (this._requestsMade >= this.options.maxRequests) {
            return fail('budget-exhausted', `Request budget of ${this.options.maxRequests} exhausted`);
          }
          attempts += 1;
          await this.pacer.wait(hostnameOf(current));
          this._requestsMade += 1;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error('timeout')), this.options.requestTimeoutMs);
          const onOuterAbort = () => controller.abort(reqOptions.signal?.reason);
          reqOptions.signal?.addEventListener('abort', onOuterAbort, { once: true });
          try {
            response = await undiciFetch(current, {
              method: reqOptions.method ?? 'GET',
              redirect: 'manual',
              dispatcher: this.dispatcher,
              signal: controller.signal,
              headers: {
                'user-agent': this.options.userAgent,
                accept: reqOptions.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
                'accept-language': 'en',
                ...(reqOptions.body !== undefined ? { 'content-type': reqOptions.contentType ?? 'application/json' } : {}),
                ...(extraHeaders && new URL(current).origin === extraHeadersOrigin ? extraHeaders : {}),
              },
              ...(reqOptions.body !== undefined && (reqOptions.method ?? 'GET') === 'POST' ? { body: reqOptions.body } : {}),
            });
            lastError = undefined;
            if (RETRY_STATUSES.has(response.status) && attempt < this.options.maxRetries) {
              const delay = this.retryDelay(response.headers.get('retry-after'), attempt);
              this.pacer.backoff(hostnameOf(current), delay);
              await response.body?.cancel().catch(() => {});
              response = undefined;
              clearTimeout(timer);
              reqOptions.signal?.removeEventListener('abort', onOuterAbort);
              continue;
            }
            // Success path: keep the timer alive for body reading; it is cleared below.
            const outcome = await this.consume(response, current, url, chain, started, attempts, reqOptions, controller.signal);
            clearTimeout(timer);
            reqOptions.signal?.removeEventListener('abort', onOuterAbort);
            if (outcome.kind === 'redirect') {
              current = outcome.location;
              if (chain.length > this.options.maxRedirects) {
                return fail('too-many-redirects', `More than ${this.options.maxRedirects} redirects`);
              }
              response = undefined;
              break; // out of retry loop, continue hop loop
            }
            return outcome.result;
          } catch (err) {
            clearTimeout(timer);
            reqOptions.signal?.removeEventListener('abort', onOuterAbort);
            lastError = err;
            if (isSsrfError(err)) return fail('ssrf-blocked', errorMessage(err));
            if (isTimeout(err)) {
              if (attempt < this.options.maxRetries) {
                await this.sleep(this.retryDelay(null, attempt));
                continue;
              }
              return fail('timeout', `Timed out after ${this.options.requestTimeoutMs}ms`);
            }
            if (attempt < this.options.maxRetries) {
              await this.sleep(this.retryDelay(null, attempt));
              continue;
            }
            return fail('network', errorMessage(err));
          }
        }
      } finally {
        release();
      }

      if (!response && lastError) return fail('network', errorMessage(lastError));
      if (!response && chain.length === 0) return fail('network', 'No response received');
      // Loop continues with the redirect target.
    }
  }

  private checkTarget(url: string): { kind: FetchFailureKind; message: string } | null {
    if (!this.options.scope.isInScope(url)) return { kind: 'out-of-scope', message: `Out of scope: ${url}` };
    if (this.options.scope.isProhibitedPath(url)) return { kind: 'prohibited', message: `Prohibited path: ${url}` };
    const host = hostnameOf(url);
    if (!this.options.allowPrivate && isBlockedHostname(host)) {
      return { kind: 'ssrf-blocked', message: `Blocked host: ${host}` };
    }
    return null;
  }

  private retryDelay(retryAfter: string | null, attempt: number): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 15_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 15_000);
    }
    return Math.min(500 * 2 ** attempt, 8_000);
  }

  private async consume(
    response: Awaited<ReturnType<typeof undiciFetch>>,
    current: string,
    requestedUrl: string,
    chain: RedirectHop[],
    started: number,
    attempts: number,
    reqOptions: FetchRequestOptions,
    signal: AbortSignal,
  ): Promise<{ kind: 'redirect'; location: string } | { kind: 'done'; result: FetchOutcome }> {
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return { kind: 'done', result: this.failure(requestedUrl, 'network', `Redirect ${response.status} without Location`, chain, started, attempts) };
      }
      const next = normalizeUrl(location, current, FETCH_NORMALIZE);
      if (!next) {
        return { kind: 'done', result: this.failure(requestedUrl, 'network', `Unparseable redirect target: ${location}`, chain, started, attempts) };
      }
      if (next === current || chain.some((hop) => hop.url === next)) {
        chain.push({ url: current, status: response.status });
        return { kind: 'done', result: this.failure(requestedUrl, 'too-many-redirects', `Redirect loop: ${next} was already visited`, chain, started, attempts) };
      }
      chain.push({ url: current, status: response.status });
      return { kind: 'redirect', location: next };
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const contentType = headers['content-type'];

    let body = Buffer.alloc(0);
    let bodySkipped = false;
    if (reqOptions.acceptTypes && contentType && !reqOptions.acceptTypes.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      bodySkipped = true;
    } else if (response.body) {
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > this.options.maxResponseBytes) {
        await response.body.cancel().catch(() => {});
        return { kind: 'done', result: this.failure(requestedUrl, 'too-large', `Content-Length ${declared} exceeds ${this.options.maxResponseBytes}`, chain, started, attempts) };
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          if (signal.aborted) throw signal.reason ?? new Error('timeout');
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.options.maxResponseBytes) {
            await reader.cancel().catch(() => {});
            return { kind: 'done', result: this.failure(requestedUrl, 'too-large', `Body exceeded ${this.options.maxResponseBytes} bytes`, chain, started, attempts) };
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      body = Buffer.concat(chunks);
      if (looksGzipped(current, contentType, body)) {
        try {
          body = gunzipSync(body, { maxOutputLength: this.options.maxResponseBytes });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
            return { kind: 'done', result: this.failure(requestedUrl, 'too-large', `Decompressed body exceeds ${this.options.maxResponseBytes} bytes`, chain, started, attempts) };
          }
          // Otherwise leave the bytes as-is; the caller decides what to do with them.
        }
      }
    }

    return {
      kind: 'done',
      result: {
        ok: true,
        requestedUrl,
        finalUrl: current,
        status: response.status,
        headers,
        contentType,
        body,
        bodySkipped,
        redirectChain: chain,
        durationMs: Date.now() - started,
        attempts,
      },
    };
  }

  private failure(requestedUrl: string, kind: FetchFailureKind, message: string, chain: RedirectHop[], started: number, attempts: number): FetchFailure {
    return { ok: false, requestedUrl, kind, message, redirectChain: chain, durationMs: Date.now() - started, attempts };
  }
}

function looksGzipped(_url: string, _contentType: string | undefined, body: Buffer): boolean {
  // The gzip magic number is decisive regardless of what the server declared.
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
}

function isSsrfError(err: unknown): boolean {
  if (err instanceof SsrfBlockedError) return true;
  const code = (err as { code?: string } | undefined)?.code;
  const causeCode = ((err as { cause?: { code?: string } } | undefined)?.cause)?.code;
  return code === 'ESSRFBLOCKED' || causeCode === 'ESSRFBLOCKED';
}

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  const code = (err as { code?: string }).code;
  const causeCode = (err.cause as { code?: string } | undefined)?.code;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    err.message === 'timeout' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    causeCode === 'UND_ERR_CONNECT_TIMEOUT'
  );
}
