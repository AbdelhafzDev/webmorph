import * as cheerio from 'cheerio';
import { extractPageData } from './pageData.js';

/** One result of a listing or search page read over HTTP: the link, plus whatever the page's structured data says about it. */
export interface ListItem {
  title: string;
  url: string;
  image?: string;
  description?: string;
  price?: number;
  currency?: string;
  availability?: string;
  condition?: string;
}

export interface ListData {
  results: ListItem[];
  count: number;
  /** Entries of a schema.org ItemList on the page, whether or not they matched the result pattern. */
  itemListCount: number;
  /** Result links found in the main content, before structured-data enrichment. */
  linkCount: number;
}

export interface ListExtractOptions {
  /** The page's own URL: relative links resolve against it, and self references are not results. */
  pageUrl: string;
  /** Regular expression tested against each link's pathname. */
  hrefPattern: string;
  excludeHrefPattern?: string;
  maxItems: number;
  /** Lower-case hostnames whose links count as results. */
  allowedHosts: string[];
}

const CHROME = 'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [aria-label*="breadcrumb" i]';

/**
 * The result list of a server-rendered listing or search page: anchors in the main content whose pathname matches
 * the result pattern (site chrome excluded, same rules as the in-browser extractor), enriched with the schema.org
 * `ItemList` the page publishes when its entries share those URLs. Entries of the ItemList that match the pattern
 * but have no anchor are results too: the page vouches for them.
 */
export function extractListData(html: string, options: ListExtractOptions): ListData {
  const $ = cheerio.load(html);
  const re = new RegExp(options.hrefPattern);
  const ex = options.excludeHrefPattern ? new RegExp(options.excludeHrefPattern) : null;
  let page: URL | undefined;
  try {
    page = new URL(options.pageUrl);
  } catch {
    page = undefined;
  }
  const self = page ? `${page.pathname}${page.search}` : '';
  const hosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

  const resolve = (href: string | undefined): URL | undefined => {
    if (!href) return undefined;
    try {
      return new URL(href, page);
    } catch {
      return undefined;
    }
  };
  const accepts = (u: URL): boolean => {
    if (!/^https?:$/.test(u.protocol) || !hosts.has(u.hostname.toLowerCase())) return false;
    if (!re.test(u.pathname) || (ex && ex.test(u.pathname))) return false;
    return `${u.pathname}${u.search}` !== self;
  };
  const keyOf = (u: URL) => `${u.origin}${u.pathname}${u.search}`;

  const root = $('main, [role="main"]').first().length ? $('main, [role="main"]').first() : $('body');
  const byKey = new Map<string, ListItem>();
  let linkCount = 0;
  root.find('a[href]').each((_, el) => {
    const a = $(el);
    if (a.closest(CHROME).length) return;
    const u = resolve(a.attr('href'));
    if (!u || !accepts(u)) return;
    const key = keyOf(u);
    if (byKey.has(key)) return;
    const title = clean(a.text()) || clean(a.attr('aria-label')) || clean(a.find('img[alt]').first().attr('alt'));
    if (!title) return;
    byKey.set(key, { title: title.slice(0, 200), url: key });
    linkCount += 1;
  });

  // schema.org ItemList entries: name, url, image, description and an Offer when present.
  let itemListCount = 0;
  const { jsonLd } = extractPageData(html, { meta: false, embeddedJson: false, jsonLd: true });
  const lists = jsonLd.flatMap((d) => flattenGraph(d)).filter((d) => typeOf(d) === 'ItemList');
  for (const list of lists) {
    const elements = Array.isArray(list['itemListElement']) ? (list['itemListElement'] as unknown[]) : [];
    for (const element of elements) {
      const entry = asRecord(element);
      if (!entry) continue;
      const item = asRecord(entry['item']) ?? entry;
      const u = resolve(stringOf(item['url']) ?? stringOf(entry['url']));
      itemListCount += 1;
      if (!u || !accepts(u)) continue;
      const key = keyOf(u);
      const offer = asRecord(Array.isArray(item['offers']) ? (item['offers'] as unknown[])[0] : item['offers']);
      const fields: Partial<ListItem> = {
        ...(stringOf(item['image']) ? { image: stringOf(item['image']) } : Array.isArray(item['image']) && stringOf((item['image'] as unknown[])[0]) ? { image: stringOf((item['image'] as unknown[])[0]) } : {}),
        ...(stringOf(item['description']) ? { description: clean(stringOf(item['description'])).slice(0, 500) } : {}),
        ...(numberOf(offer?.['price']) !== undefined ? { price: numberOf(offer?.['price']) } : {}),
        ...(stringOf(offer?.['priceCurrency']) ? { currency: stringOf(offer?.['priceCurrency']) } : {}),
        ...(stringOf(offer?.['availability']) ? { availability: lastSegment(stringOf(offer?.['availability'])!) } : {}),
        ...(stringOf(offer?.['itemCondition'] ?? item['itemCondition']) ? { condition: lastSegment(stringOf(offer?.['itemCondition'] ?? item['itemCondition'])!) } : {}),
      };
      const existing = byKey.get(key);
      if (existing) Object.assign(existing, fields);
      else {
        const title = clean(stringOf(item['name']) ?? stringOf(entry['name']));
        if (title) byKey.set(key, { title: title.slice(0, 200), url: key, ...fields });
      }
    }
  }

  const results = Array.from(byKey.values()).slice(0, options.maxItems);
  return { results, count: results.length, itemListCount, linkCount };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function typeOf(d: Record<string, unknown>): string | undefined {
  const t = d['@type'];
  return typeof t === 'string' ? t : Array.isArray(t) ? stringOf(t[0]) : undefined;
}

/** `https://schema.org/InStock` -> `InStock`; plain values pass through. */
function lastSegment(value: string): string {
  return value.replace(/\/+$/, '').split('/').pop() ?? value;
}

/** A JSON-LD document may be a single node or a `@graph` of nodes. */
function flattenGraph(d: unknown): Record<string, unknown>[] {
  const rec = asRecord(d);
  if (!rec) return [];
  const graph = rec['@graph'];
  return Array.isArray(graph) ? graph.flatMap((g) => flattenGraph(g)) : [rec];
}
