import { shortHash } from '../core/ids.js';
import type { PageRecord } from '../schemas/pageInventory.js';
import type { PageTemplate, TemplateKind } from '../schemas/pageTemplates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = /\.(html?|php|aspx?|jsp|cfm)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** First-pass pattern: only segments that are unambiguously identifiers are generalized. */
export function urlPattern(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map(classifySegment);
  const path = '/' + segments.join('/');
  const keys = Array.from(new Set(Array.from(parsed.searchParams.keys()))).sort();
  return keys.length ? `${path}?${keys.join(',')}` : path;
}

export function classifySegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // keep raw
  }
  let ext = '';
  const extMatch = s.match(EXT);
  if (extMatch) {
    ext = extMatch[0].toLowerCase();
    s = s.slice(0, -ext.length);
  }
  if (/^\d+$/.test(s)) return `{id}${ext}`;
  if (UUID.test(s)) return `{id}${ext}`;
  if (/^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s)) return `{id}${ext}`;
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return `{id}${ext}`;
  // API and route versions (v2, api_v1, syarah_v1) are literals, not identifiers.
  if (/^(?:[a-z]+[_-]?)?v\d+(?:[._]\d+)*$/i.test(s)) return `${s.toLowerCase()}${ext}`;
  if (/\d/.test(s) && /[-_]/.test(s) && s.length >= 6) return `{slug}${ext}`;
  if (/^[a-z]+-\d+$/i.test(s)) return `{slug}${ext}`;
  return `${s.toLowerCase()}${ext}`;
}

export interface TemplateInput {
  url: string;
  skeletonHash?: string;
  depth: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  pages: TemplateInput[];
}

export interface GeneralizeOptions {
  /** Minimum sibling literal leaves before considering a collapse. */
  minSiblings?: number;
  /** Required share of a dominant skeleton hash among those siblings. */
  minCohesion?: number;
  /** Required share for siblings directly under the root, where distinct pages (about, pricing, careers) are common. */
  rootCohesion?: number;
  /**
   * How many distinct literal children a path prefix is known to have beyond the crawled pages
   * (from sitemaps, for instance). A family that size collapses with as few as two crawled members.
   */
  familySize?: (prefix: string[]) => number;
}

/**
 * Index of path families in a URL inventory: `familySize(['en', 'autos'])` is the number of distinct
 * literal segments seen under /en/autos. A `{slug}` or `{id}` label in the prefix matches any segment.
 */
export function buildFamilyIndex(urls: string[]): (prefix: string[]) => number {
  interface Node {
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const url of urls) {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    let node = root;
    for (const seg of pathname.split('/').filter(Boolean).map(classifySegment)) {
      let next = node.children.get(seg);
      if (!next) {
        next = { children: new Map() };
        node.children.set(seg, next);
      }
      node = next;
    }
  }
  return (prefix) => {
    let nodes = [root];
    for (const label of prefix) {
      const next: Node[] = [];
      for (const node of nodes) {
        if (label.startsWith('{')) next.push(...node.children.values());
        else {
          const child = node.children.get(label);
          if (child) next.push(child);
        }
      }
      if (next.length === 0) return 0;
      nodes = next;
    }
    let best = 0;
    for (const node of nodes) {
      const literal = Array.from(node.children.keys()).filter((k) => !k.startsWith('{')).length;
      if (literal > best) best = literal;
    }
    return best;
  };
}

/**
 * Second pass: collapse groups of literal sibling leaves into `{slug}` when the
 * pages behind them share a DOM skeleton. Evidence-based, so `/docs/intro`,
 * `/docs/install`, ... become `/docs/{slug}` while `/about`, `/pricing` stay apart.
 */
export function generalizePatterns(pages: TemplateInput[], options: GeneralizeOptions = {}): Map<string, string> {
  const minSiblings = options.minSiblings ?? 4;
  const minCohesion = options.minCohesion ?? 0.6;
  const rootCohesion = options.rootCohesion ?? 0.8;

  const root: TrieNode = { children: new Map(), pages: [] };
  const queryOf = new Map<string, string>();

  for (const page of pages) {
    const pattern = urlPattern(page.url);
    const [path, query] = splitQuery(pattern);
    queryOf.set(page.url, query);
    const segments = path.split('/').filter(Boolean);
    let node = root;
    for (const seg of segments) {
      let next = node.children.get(seg);
      if (!next) {
        next = { children: new Map(), pages: [] };
        node.children.set(seg, next);
      }
      node = next;
    }
    node.pages.push(page);
  }

  const result = new Map<string, string>();
  const visit = (node: TrieNode, prefix: string[]) => {
    const literalLeaves = Array.from(node.children.entries()).filter(
      ([seg, child]) => !seg.startsWith('{') && child.children.size === 0 && child.pages.length > 0,
    );
    let collapsed = new Set<string>();
    // Inventory-backed collapses apply below a literal section (/autos/{make}), never to the top-level
    // segments themselves (/{section}), with or without a locale prefix: those are sections by convention.
    const sectionDepth = prefix.length - (prefix[0] && LOCALE_SEGMENT.test(prefix[0]) ? 1 : 0);
    const known = sectionDepth >= 1 ? (options.familySize?.(prefix) ?? 0) : 0;
    const knownFamily = literalLeaves.length >= 2 && literalLeaves.length < minSiblings && known >= minSiblings;
    if (literalLeaves.length >= minSiblings || knownFamily) {
      const leafPages = literalLeaves.flatMap(([, child]) => child.pages);
      const cohesion = dominantShare(leafPages.map((p) => p.skeletonHash));
      if (cohesion >= (prefix.length === 0 ? rootCohesion : minCohesion)) {
        collapsed = new Set(literalLeaves.map(([seg]) => seg));
      }
    }
    // Literal segments with children (/autos/toyota/{id} when the inventory lists a hundred makes under /autos)
    // are family members too; there are no sibling pages to compare, so the bar is a large declared family
    // and a segment that is not a well-known section name.
    if (prefix.length > 0 && known >= LARGE_FAMILY) {
      for (const [seg, child] of node.children) {
        if (seg.startsWith('{') || child.children.size === 0 || RESERVED_SEGMENTS.has(seg)) continue;
        collapsed.add(seg);
      }
    }
    for (const [seg, child] of node.children) {
      const label = collapsed.has(seg) ? '{slug}' : seg;
      const nextPrefix = [...prefix, label];
      for (const page of child.pages) {
        const query = queryOf.get(page.url) ?? '';
        result.set(page.url, '/' + nextPrefix.join('/') + query);
      }
      visit(child, nextPrefix);
    }
  };
  for (const page of root.pages) result.set(page.url, '/' + (queryOf.get(page.url) ?? ''));
  visit(root, []);
  return result;
}

function splitQuery(pattern: string): [string, string] {
  const i = pattern.indexOf('?');
  return i >= 0 ? [pattern.slice(0, i), pattern.slice(i)] : [pattern, ''];
}

function dominantShare(hashes: Array<string | undefined>): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const h of hashes) {
    if (!h) continue;
    total += 1;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  if (total === 0) return 0;
  return Math.max(...counts.values()) / total;
}

const DOC_SEGMENTS = new Set(['docs', 'documentation', 'developer', 'developers', 'api', 'api-docs', 'reference', 'guides', 'guide', 'help', 'support', 'kb', 'knowledge-base', 'manual', 'learn', 'tutorials']);
const AUTH_SEGMENTS = new Set(['login', 'log-in', 'signin', 'sign-in', 'register', 'signup', 'sign-up', 'auth', 'password', 'forgot-password', 'reset-password', 'logout', 'sso', 'oauth']);
const ACCOUNT_SEGMENTS = new Set(['account', 'accounts', 'profile', 'settings', 'dashboard', 'my-account', 'my', 'me', 'user', 'users', 'orders', 'billing']);
const LEGAL_SEGMENTS = new Set(['privacy', 'privacy-policy', 'terms', 'terms-of-service', 'tos', 'cookies', 'cookie-policy', 'legal', 'imprint', 'impressum', 'disclaimer', 'accessibility']);
const LISTING_SEGMENTS = new Set(['category', 'categories', 'collections', 'collection', 'products', 'shop', 'catalog', 'catalogue', 'blog', 'news', 'articles', 'posts', 'tags', 'tag', 'c', 'browse', 'listings', 'directory', 'search', 'results', 'events', 'jobs', 'careers']);
const ARTICLE_SEGMENTS = new Set(['blog', 'news', 'articles', 'posts', 'post', 'article', 'stories', 'story', 'press', 'insights']);
/** schema.org types that describe a page listing several items rather than one entity. */
const LIST_JSONLD_TYPES = new Set(['ItemList', 'CollectionPage', 'SearchResultsPage', 'OfferCatalog']);
/** Declared literal children under a prefix before non-leaf literals there are taken as family members. */
const LARGE_FAMILY = 8;
const RESERVED_SEGMENTS = new Set([...DOC_SEGMENTS, ...AUTH_SEGMENTS, ...ACCOUNT_SEGMENTS, ...LEGAL_SEGMENTS, ...LISTING_SEGMENTS, ...ARTICLE_SEGMENTS]);

export function classifyTemplate(pattern: string, pages: PageRecord[]): { kind: TemplateKind; reasons: string[] } {
  const reasons: string[] = [];
  const [path, query] = splitQuery(pattern);
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  const last = segments[segments.length - 1] ?? '';
  const queryKeys = query ? query.slice(1).split(',') : [];
  const htmlPages = pages.filter((p) => p.html);
  const forms = htmlPages.flatMap((p) => p.html!.forms);
  const hasPasswordForm = forms.some((f) => f.hasPassword);
  const lastIsPlaceholder = last.startsWith('{');

  if (path === '/' && queryKeys.length === 0) return { kind: 'home', reasons: ['root path'] };

  if (segments.some((s) => AUTH_SEGMENTS.has(s))) reasons.push('auth path segment');
  if (hasPasswordForm) reasons.push('form with password field');
  if (reasons.length) return { kind: 'auth', reasons };

  if (ACCOUNT_SEGMENTS.has(first)) return { kind: 'account', reasons: [`account path segment "${first}"`] };
  if (segments.some((s) => LEGAL_SEGMENTS.has(s))) return { kind: 'legal', reasons: ['legal path segment'] };
  const docSegment = segments.find((s) => DOC_SEGMENTS.has(s));
  if (docSegment) return { kind: 'documentation', reasons: [`documentation path segment "${docSegment}"`] };

  const searchKeys = queryKeys.filter((k) => ['q', 'query', 's', 'search', 'keyword', 'keywords', 'term'].includes(k.toLowerCase()));
  if (searchKeys.length || segments.includes('search')) {
    return { kind: 'search', reasons: [searchKeys.length ? `query keys ${searchKeys.join(',')}` : 'search path segment'] };
  }

  const detailLinkRatio = detailLinkShare(htmlPages);
  if (lastIsPlaceholder) {
    if (segments.some((s) => ARTICLE_SEGMENTS.has(s))) return { kind: 'article', reasons: ['article section with identifier segment'] };
    // /autos/{slug} pages that declare a list of items (a brand or category page) are listings, not entity pages.
    const listTyped = htmlPages.filter((p) => p.html!.jsonLdTypes.some((t) => LIST_JSONLD_TYPES.has(t)));
    if (htmlPages.length > 0 && listTyped.length * 2 >= htmlPages.length) {
      return { kind: 'listing', reasons: [`identifier segment "${last}" but pages carry ${Array.from(new Set(listTyped.flatMap((p) => p.html!.jsonLdTypes.filter((t) => LIST_JSONLD_TYPES.has(t))))).join('/')} structured data`] };
    }
    // A page that links many times to one other identifier-bearing pattern is a listing of those pages
    // (a brand page listing cars); a few "related" links on an entity page stay below the bar.
    const dominant = dominantLinkedPattern(htmlPages, path);
    if (dominant && dominant.perPage >= LISTING_LINKS_PER_PAGE) {
      return { kind: 'listing', reasons: [`identifier segment "${last}" but pages link ${Math.round(dominant.perPage)} times each to ${dominant.pattern}`] };
    }
    return { kind: 'detail', reasons: [`identifier segment "${last}"`] };
  }
  if (LISTING_SEGMENTS.has(first) || LISTING_SEGMENTS.has(last)) {
    return { kind: 'listing', reasons: [`listing path segment`, ...(detailLinkRatio > 0.3 ? ['many links to detail pages'] : [])] };
  }
  if (detailLinkRatio > 0.5 && htmlPages.length > 0) return { kind: 'listing', reasons: ['majority of links point to detail pages'] };
  if (queryKeys.some((k) => ['page', 'p', 'offset', 'sort', 'order', 'filter'].includes(k.toLowerCase()))) {
    return { kind: 'listing', reasons: ['pagination or sort query keys'] };
  }
  const nonSearchForms = forms.filter((f) => f.classification !== 'search' && f.classification !== 'filter');
  if (nonSearchForms.length > 0 && nonSearchForms.some((f) => ['contact', 'subscribe', 'unknown'].includes(f.classification) && f.fields.length >= 2)) {
    return { kind: 'form', reasons: [`${nonSearchForms[0]!.classification} form`] };
  }
  return { kind: 'other', reasons: ['no matching heuristic'] };
}

/** Average links per page to one foreign identifier-bearing pattern before a page counts as a listing. */
const LISTING_LINKS_PER_PAGE = 8;

/** The identifier-bearing link pattern these pages point at most, other than their own, with its per-page average. */
function dominantLinkedPattern(pages: PageRecord[], ownPath: string): { pattern: string; perPage: number } | undefined {
  if (pages.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const link of page.html?.links ?? []) {
      if (!link.inScope || seen.has(link.href)) continue;
      seen.add(link.href);
      const p = splitQuery(urlPattern(link.href))[0];
      const last = p.split('/').filter(Boolean).pop() ?? '';
      if (!last.startsWith('{') || p === ownPath) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return best ? { pattern: best[0], perPage: best[1] / pages.length } : undefined;
}

/** Share of in-scope links on these pages whose own pattern ends with an identifier. */
function detailLinkShare(pages: PageRecord[]): number {
  let total = 0;
  let detail = 0;
  for (const page of pages) {
    for (const link of page.html?.links ?? []) {
      if (!link.inScope) continue;
      total += 1;
      const p = urlPattern(link.href);
      const last = splitQuery(p)[0].split('/').filter(Boolean).pop() ?? '';
      if (last.startsWith('{')) detail += 1;
    }
  }
  return total ? detail / total : 0;
}

export interface BuildTemplatesOptions {
  maxUrlsPerTemplate?: number;
  representatives?: number;
  /** See GeneralizeOptions.familySize. */
  familySize?: (prefix: string[]) => number;
}

export function buildTemplates(pages: PageRecord[], options: BuildTemplatesOptions = {}): PageTemplate[] {
  const maxUrls = options.maxUrlsPerTemplate ?? 50;
  const representatives = options.representatives ?? 3;
  const okPages = pages.filter((p) => p.outcome === 'ok' && p.html);

  const patterns = generalizePatterns(
    okPages.map((p) => ({ url: p.finalUrl, skeletonHash: p.html?.skeletonHash, depth: p.depth })),
    options.familySize ? { familySize: options.familySize } : {},
  );
  const groups = new Map<string, PageRecord[]>();
  for (const page of okPages) {
    const pattern = patterns.get(page.finalUrl) ?? urlPattern(page.finalUrl);
    const list = groups.get(pattern) ?? [];
    list.push(page);
    groups.set(pattern, list);
  }

  // /{id}/{slug} and /{id}/{id} are one template when a slug happened to look like an identifier: merge by placeholder-blind key.
  const merged = new Map<string, { pattern: string; members: PageRecord[] }>();
  for (const [pattern, members] of groups) {
    const key = pattern.replace(/\{(id|slug)\}/g, '{x}');
    const existing = merged.get(key);
    if (!existing) merged.set(key, { pattern, members: [...members] });
    else {
      existing.members.push(...members);
      if (members.length > existing.members.length - members.length) existing.pattern = pattern;
    }
  }
  const templates: PageTemplate[] = [];
  for (const { pattern, members } of merged.values()) {
    const hashCounts = new Map<string, number>();
    for (const m of members) {
      const h = m.html!.skeletonHash;
      hashCounts.set(h, (hashCounts.get(h) ?? 0) + 1);
    }
    const skeletonHashes = Array.from(hashCounts.entries())
      .map(([hash, count]) => ({ hash, count }))
      .sort((a, b) => b.count - a.count);
    const dominant = skeletonHashes[0]?.hash;
    const cohesion = members.length ? (skeletonHashes[0]?.count ?? 0) / members.length : 0;

    const sorted = [...members].sort((a, b) => {
      const aDom = a.html!.skeletonHash === dominant ? 0 : 1;
      const bDom = b.html!.skeletonHash === dominant ? 0 : 1;
      return aDom - bDom || a.depth - b.depth || a.finalUrl.length - b.finalUrl.length;
    });

    const renderModes: Record<string, number> = {};
    const formClassifications = new Set<string>();
    for (const m of members) {
      renderModes[m.html!.renderMode.kind] = (renderModes[m.html!.renderMode.kind] ?? 0) + 1;
      for (const f of m.html!.forms) formClassifications.add(f.classification);
    }

    const { kind, reasons } = classifyTemplate(pattern, members);
    templates.push({
      templateId: `tpl-${shortHash(pattern, 10)}`,
      urlPattern: pattern,
      kind,
      kindReasons: reasons,
      pageCount: members.length,
      representativeUrls: sorted.slice(0, representatives).map((m) => m.finalUrl),
      urls: sorted.slice(0, maxUrls).map((m) => m.finalUrl),
      urlsTruncated: members.length > maxUrls,
      skeletonHashes,
      cohesion: Math.round(cohesion * 1000) / 1000,
      renderModes: renderModes as PageTemplate['renderModes'],
      hasForms: members.some((m) => m.html!.forms.length > 0),
      formClassifications: Array.from(formClassifications).sort(),
    });
  }

  return templates.sort((a, b) => b.pageCount - a.pageCount || a.urlPattern.localeCompare(b.urlPattern));
}
