const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid|srsltid|ref_src|spm)$/i;

export interface NormalizeOptions {
  /** Keep query parameters as-is (no tracking removal, no sorting). */
  keepQuery?: boolean;
  /** Keep a trailing slash. Required when the URL will be fetched: servers treat /a and /a/ differently. */
  keepTrailingSlash?: boolean;
}

/** Normalization for URLs that are about to be fetched: resolve and tidy, but change nothing a server might care about. */
export const FETCH_NORMALIZE: NormalizeOptions = { keepQuery: true, keepTrailingSlash: true };

/**
 * Normalize a URL for deduplication. Returns null for anything that is not an
 * absolute http(s) URL after resolution against `base`.
 */
export function normalizeUrl(input: string, base?: string, options: NormalizeOptions = {}): string | null {
  let url: URL;
  try {
    url = base ? new URL(input.trim(), base) : new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.username = '';
  url.password = '';
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  if (!options.keepQuery) {
    const kept: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams) {
      if (!TRACKING_PARAM.test(key)) kept.push([key, value]);
    }
    kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
    url.search = '';
    for (const [key, value] of kept) url.searchParams.append(key, value);
  }

  if (!options.keepTrailingSlash && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  // Collapse repeated slashes inside the path.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');

  return url.toString();
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export function isIpLiteral(host: string): boolean {
  // IPv6 literals in URLs are bracketed; URL.hostname keeps the brackets.
  return /^\[?[0-9a-f:.]+\]?$/i.test(host) && (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host));
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

const TWO_PART_SUFFIXES = new Set(['com.sa', 'net.sa', 'org.sa', 'edu.sa', 'gov.sa', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.in', 'co.nz', 'com.br', 'com.mx', 'com.tr', 'com.eg', 'co.za', 'com.sg', 'com.hk', 'com.cn', 'co.kr', 'com.ar', 'com.ae', 'co.il', 'com.my', 'com.ph', 'com.pk', 'com.ng', 'co.id', 'com.vn', 'com.tw']);

/** Registrable domain with a small table of two-part public suffixes: sub.shop.example.co.uk -> example.co.uk */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** Same registrable domain: sitemapfiles.haraj.com.sa and haraj.com.sa are the same site. */
/**
 * Paths that serve a front end's own static files (bundles, images, fonts, translation and locale files):
 * fetched by XHR, but data about the application, not about the site's entities.
 */
export const STATIC_ASSET_PATH = /\/(assets|static|_next\/static|i18n|locales?|translations?|translation[-_]files)\/|\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(\?|$)/i;

export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/** `www.example.com` <-> `example.com`. Returns null when no counterpart applies. */
export function wwwCounterpart(host: string): string | null {
  if (host.startsWith('www.')) return host.slice(4);
  if (host.split('.').length === 2) return `www.${host}`;
  return null;
}
