import type { NetworkRecord } from '../schemas/networkEvidence.js';

export const HEADER_ALLOWLIST = ['content-type', 'accept', 'cache-control', 'content-length', 'etag', 'last-modified', 'x-request-id'];
export const QUERY_DENYLIST = ['token', 'auth', 'key', 'secret', 'session', 'sid', 'password', 'passwd', 'pwd', 'signature', 'sig', 'credential', 'bearer', 'jwt', 'otp', 'code', 'email', 'phone'];
const DENY = new RegExp(`(${QUERY_DENYLIST.join('|')})`, 'i');
const CREDENTIAL_HEADERS = ['cookie', 'authorization', 'x-api-key', 'x-auth-token', 'x-access-token', 'proxy-authorization'];

/** Replace the values of sensitive-looking query parameters. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of Array.from(u.searchParams.keys())) {
      if (DENY.test(key)) {
        u.searchParams.set(key, '[redacted]');
        changed = true;
      }
    }
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

const INFRA_COOKIE = /^(AWSALB|AWSALBTG|AWSALBCORS|AWSALBTGCORS|__cf_bm|cf_clearance|_cfuvid|__cflb|_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|__utm|_pk_|ajs_|amp_|cookieconsent|OptanonConsent|euconsent|lang|locale|i18n|theme|timezone|tz|currency|country|NID|ARRAffinity|JSESSIONID_INFRA)/i;
const AUTH_COOKIE = /(sess|token|auth|jwt|\bsid\b|login|logged|user|account|identity|remember|credential|secure|access|refresh|csrf|xsrf)/i;

/** Cookie names carried by a request (values are never kept). */
export function cookieNames(headers: Record<string, string>): string[] {
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie')?.[1] ?? '';
  return raw
    .split(';')
    .map((c) => c.trim().split('=')[0] ?? '')
    .filter(Boolean)
    .slice(0, 40);
}

/** Lowercase names of authorization-style request headers that carried a value. Names only, never values; cookies are reported separately. */
export function credentialHeaderNames(headers: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower !== 'cookie' && CREDENTIAL_HEADERS.includes(lower) && value.length > 0) names.add(lower);
  }
  return Array.from(names).sort();
}

/** Does any cookie name look like a session or token? Infrastructure cookies every anonymous visitor receives do not count. */
export function hasAuthCookie(names: readonly string[]): boolean {
  return names.some((name) => !INFRA_COOKIE.test(name) && AUTH_COOKIE.test(name));
}

/**
 * A request is credentialed when it carries an authorization-style header or a
 * cookie whose name looks like a session or token. Load-balancer, analytics and
 * preference cookies that every anonymous visitor receives do not count.
 */
export function isCredentialed(headers: Record<string, string>): boolean {
  return credentialHeaderNames(headers).length > 0 || hasAuthCookie(cookieNames(headers));
}

/** Shape of a JSON body without keeping the body: top-level keys, or array length and first-item keys. */
export function shapeOfJson(text: string): NetworkRecord['responseShape'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    const first = parsed.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
    return { kind: 'array', length: parsed.length, ...(first ? { itemKeys: Object.keys(first).slice(0, 40) } : {}) };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 40);
    const listKey = keys.find((k) => Array.isArray(obj[k]));
    const list = listKey ? (obj[listKey] as unknown[]) : undefined;
    const first = list?.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
    return { kind: 'object', keys, ...(list ? { length: list.length } : {}), ...(first ? { itemKeys: Object.keys(first).slice(0, 40) } : {}) };
  }
  return { kind: 'other' };
}

export function keysOfJson(text: string | null | undefined): string[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed as object).slice(0, 40);
  } catch {
    // not JSON
  }
  return undefined;
}
