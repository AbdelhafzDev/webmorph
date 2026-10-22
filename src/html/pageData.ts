import * as cheerio from 'cheerio';

export interface PageData {
  title?: string;
  description?: string;
  canonical?: string;
  og: Record<string, string>;
  jsonLd: unknown[];
  jsonLdTypes: string[];
  breadcrumbs: string[];
  embedded: Record<string, unknown>;
}

const MAX_BLOB = 512 * 1024;

/** Structured data embedded in an HTML document: JSON-LD, Open Graph and meta tags, JSON state blobs. */
export function extractPageData(html: string, options: { jsonLd?: boolean; meta?: boolean; embeddedJson?: boolean } = {}): PageData {
  const $ = cheerio.load(html);
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim() || undefined;
  const out: PageData = { og: {}, jsonLd: [], jsonLdTypes: [], breadcrumbs: [], embedded: {} };
  out.title = clean($('title').first().text());
  if (options.meta !== false) {
    out.description = clean($('meta[name="description"]').attr('content')) ?? clean($('meta[property="og:description"]').attr('content'));
    out.canonical = clean($('link[rel="canonical"]').attr('href'));
    $('meta[property^="og:"], meta[property^="product:"], meta[name^="twitter:"]').each((_, el) => {
      const key = ($(el).attr('property') ?? $(el).attr('name') ?? '').trim();
      const value = clean($(el).attr('content'));
      if (key && value && !(key in out.og)) out.og[key] = value.slice(0, 500);
    });
  }
  if (options.jsonLd !== false) {
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text();
      if (raw.length > MAX_BLOB) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['@graph']) ? ((parsed as Record<string, unknown>)['@graph'] as unknown[]) : [parsed];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          out.jsonLd.push(item);
          const t = (item as Record<string, unknown>)['@type'];
          for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string' && !out.jsonLdTypes.includes(x)) out.jsonLdTypes.push(x);
          if ((item as Record<string, unknown>)['@type'] === 'BreadcrumbList') {
            for (const li of ((item as Record<string, unknown>)['itemListElement'] as Array<Record<string, unknown>> | undefined) ?? []) {
              const it = li['item'];
              const name = typeof li['name'] === 'string' ? li['name'] : it && typeof it === 'object' ? (it as Record<string, unknown>)['name'] : undefined;
              if (typeof name === 'string') out.breadcrumbs.push(name);
            }
          }
        }
      } catch {
        // malformed JSON-LD is common; skip it
      }
    });
  }
  if (options.embeddedJson !== false) {
    $('script[type="application/json"]').each((_, el) => {
      const id = $(el).attr('id') ?? `json-${Object.keys(out.embedded).length + 1}`;
      const raw = $(el).text();
      if (raw.length > MAX_BLOB) return;
      try {
        out.embedded[id] = JSON.parse(raw);
      } catch {
        // skip
      }
    });
    $('script:not([src]):not([type]), script[type="text/javascript"]').each((_, el) => {
      const raw = $(el).text();
      if (raw.length > MAX_BLOB) return;
      // window.__NAME__ = {...}; or var NAME = {...};
      const m = raw.match(/(?:window\.|var\s+|let\s+|const\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:$|\n|<)/);
      if (!m) return;
      try {
        const parsed = JSON.parse(m[2]!) as unknown;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed as object).length) out.embedded[m[1]!] = parsed;
      } catch {
        // not a JSON literal
      }
    });
  }
  return out;
}

/** True when the page carries machine-readable data worth a tool. */
export function hasStructuredData(d: PageData): boolean {
  const useful = d.jsonLd.filter((x) => !['WebSite', 'Organization', 'SoftwareApplication', 'BreadcrumbList', 'SearchAction'].includes(String((x as Record<string, unknown>)['@type'])));
  return useful.length > 0 || Object.keys(d.embedded).length > 0 || Object.keys(d.og).some((k) => /^(og:title|product:|og:price)/.test(k));
}

/** Levels of keys an embedded JSON shape describes: the object's own keys and their children's keys. */
export const EMBEDDED_SHAPE_DEPTH = 2;
/** Keys described per object at each level; the rest are counted. */
export const EMBEDDED_SHAPE_KEYS = 40;
/** Keys described in total for one embedded object, so a wide tree cannot bloat a tool definition. */
const EMBEDDED_SHAPE_NODES = 500;
/** Embedded objects described per page; a page rarely carries more than a few. */
const EMBEDDED_MAX_OBJECTS = 20;
/** Key names listed in the tool description per embedded object. */
const SUMMARY_KEYS = 12;

type JsonSchema = Record<string, unknown>;
type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

const SENSITIVE_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'credential', 'credentials',
  'auth', 'authorization', 'authentication', 'session', 'sessions', 'cookie', 'cookies', 'jwt', 'bearer', 'otp',
  'email', 'emails', 'phone', 'phones', 'telephone', 'tel', 'mobile', 'whatsapp', 'iban', 'ssn', 'passport',
]);

/** A key whose name looks like a credential or personal data (accessToken, user_email, phoneNumber, session). Named in a shape, never described. */
export function isSensitiveKey(key: string): boolean {
  if (/api[_-]?key/i.test(key)) return true;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SENSITIVE_WORDS.has(w));
}

export function kindOfJson(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
}

const NOT_DESCRIBED: JsonSchema = { description: 'not described: the key name looks like a credential or personal data' };

/**
 * JSON Schema annotation of a value's shape, observed on one page: key names and value kinds down to `depth` levels
 * of keys, at most `maxKeys` keys per object. Values never enter the result, keys that look sensitive are named and
 * not descended into, and nothing in it constrains: no `type`, so a page whose state differs from the sample cannot
 * fail validation against it.
 */
export function shapeOfValue(value: unknown, options: { depth?: number; maxKeys?: number } = {}): JsonSchema {
  return shapeNode(value, options.depth ?? EMBEDDED_SHAPE_DEPTH, options.maxKeys ?? EMBEDDED_SHAPE_KEYS, { left: EMBEDDED_SHAPE_NODES });
}

function shapeNode(value: unknown, depth: number, maxKeys: number, budget: { left: number }): JsonSchema {
  const kind = kindOfJson(value);
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (depth <= 0 || budget.left <= 0) return { description: `observed: object with ${keys.length} key(s), beyond the described depth` };
    const shown = keys.slice(0, Math.min(maxKeys, budget.left));
    budget.left -= shown.length;
    const properties: Record<string, JsonSchema> = {};
    for (const key of shown) properties[key] = isSensitiveKey(key) ? NOT_DESCRIBED : shapeNode(obj[key], depth - 1, maxKeys, budget);
    return { description: `observed: object${keys.length > shown.length ? ` (first ${shown.length} of ${keys.length} keys)` : ''}`, properties, additionalProperties: true };
  }
  if (kind === 'array') {
    const items = value as unknown[];
    const first = items.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (first && depth > 0 && budget.left > 0) return { description: 'observed: array of objects', items: shapeNode(first, depth, maxKeys, budget) };
    return { description: items.length ? `observed: array of ${kindOfJson(items[0])}s` : 'observed: array, empty on the sample page' };
  }
  return { description: `observed: ${kind}` };
}

export interface EmbeddedDescription {
  /** Output-schema fragment for the `embedded` object: top-level objects by name, each with its observed shape. */
  schema: JsonSchema;
  /** One sentence naming the objects and their keys, for the tool description. Undefined when the page had none. */
  summary?: string;
}

const label = (key: string): string => {
  const clean = key.replace(/[\s\u0000-\u001f]+/g, ' ').trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
};

/** Describe the embedded JSON a sample page carried, for the output schema and description of a page-data tool. */
export function describeEmbedded(embedded: Record<string, unknown>, sampleUrl: string): EmbeddedDescription {
  const names = Object.keys(embedded).slice(0, EMBEDDED_MAX_OBJECTS);
  const properties: Record<string, JsonSchema> = {};
  const parts: string[] = [];
  for (const name of names) {
    const value = embedded[name];
    const sensitive = isSensitiveKey(name);
    properties[name] = sensitive ? NOT_DESCRIBED : shapeOfValue(value);
    const keys = !sensitive && value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as object) : [];
    const shown = keys.slice(0, SUMMARY_KEYS).map(label);
    const suffix = keys.length ? ` (${shown.join(', ')}${keys.length > shown.length ? `, +${keys.length - shown.length} more` : ''})` : Array.isArray(value) ? ' (array)' : '';
    parts.push(`${label(name)}${suffix}`);
  }
  const intro = "JSON objects found in the page's inline scripts, keyed by variable or script id.";
  const schema: JsonSchema = {
    type: 'object',
    description: names.length
      ? `${intro} Shapes below were observed on one sample page (${sampleUrl}): keys and kinds are descriptive, not enforced, and may be absent or differ on other pages.`
      : `${intro} The sample page (${sampleUrl}) carried none.`,
    properties,
    additionalProperties: true,
  };
  return { schema, ...(parts.length ? { summary: `Embedded JSON on the sample page: ${parts.join('; ')}.` } : {}) };
}
