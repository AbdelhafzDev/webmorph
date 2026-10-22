const SEGMENT_ENTITY: Record<string, { singular: string; plural: string }> = {
  blog: { singular: 'post', plural: 'posts' },
  news: { singular: 'article', plural: 'articles' },
  articles: { singular: 'article', plural: 'articles' },
  docs: { singular: 'doc_page', plural: 'doc_pages' },
  documentation: { singular: 'doc_page', plural: 'doc_pages' },
  guides: { singular: 'guide', plural: 'guides' },
  people: { singular: 'person', plural: 'people' },
  categories: { singular: 'category', plural: 'categories' },
  c: { singular: 'category', plural: 'categories' },
  p: { singular: 'product', plural: 'products' },
};

export function snake(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 48);
}

export function singularize(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(x|z|ch|sh|s)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

export function pluralize(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('y') && !/[aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(x|z|ch|sh|s)$/.test(w)) return `${w}es`;
  if (w.endsWith('s')) return w;
  return `${w}s`;
}

/** Derive an entity name from a URL pattern such as /products/{id} or /blog/{slug}. */
export function entityFromPattern(pattern: string): { singular: string; plural: string; identifierSegment: string; parentSegment?: string } | null {
  const path = pattern.split('?')[0] ?? pattern;
  const segments = path.split('/').filter(Boolean);
  const idx = segments.findIndex((s) => s.startsWith('{'));
  if (idx < 0) return null;
  const identifierSegment = segments[idx]!.replace(/\.[a-z0-9]+$/i, '');
  const parent = idx > 0 ? segments[idx - 1]! : undefined;
  if (!parent || parent.startsWith('{')) return { singular: 'item', plural: 'items', identifierSegment, parentSegment: parent };
  const known = SEGMENT_ENTITY[parent];
  // /cardetail/{slug}, /product-details/{id}: the "detail(s)" suffix names the page, not the entity.
  const base = snake(parent.replace(/\.[a-z0-9]+$/i, '').replace(/(?<=[a-z])[-_]?details?$/i, ''));
  if (known) return { ...known, identifierSegment, parentSegment: parent };
  const singular = singularize(base);
  return { singular, plural: singular === base ? pluralize(base) : base, identifierSegment, parentSegment: parent };
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regular expression over pathnames for a URL pattern: /products/{id} -> ^/products/[^/?#]+$ */
export function patternToPathRegex(pattern: string): string {
  const path = pattern.split('?')[0] ?? pattern;
  const segments = path.split('/').filter(Boolean);
  const body = segments
    .map((s) => {
      const m = s.match(/^\{(id|slug)\}(\.[a-z0-9]+)?$/i);
      if (m) return `[^/?#]+${m[2] ? escapeRegex(m[2]) : ''}`;
      return escapeRegex(s);
    })
    .join('/');
  return `^/${body}/?$`;
}

/** Like patternToPathRegex, but a placeholder whose samples are all digits becomes \d+. */
export function patternToPathRegexFromSamples(pattern: string, sampleUrls: string[]): string {
  const path = pattern.split('?')[0] ?? pattern;
  const segments = path.split('/').filter(Boolean);
  const samples = sampleUrls
    .map((u) => {
      try {
        return new URL(u).pathname.split('/').filter(Boolean);
      } catch {
        return null;
      }
    })
    .filter((s): s is string[] => Boolean(s) && s!.length === segments.length);
  const body = segments
    .map((s, i) => {
      const m = s.match(/^\{(id|slug)\}(\.[a-z0-9]+)?$/i);
      if (!m) return escapeRegex(s);
      const allDigits = samples.length > 0 && samples.every((p) => /^\d+$/.test(p[i] ?? ''));
      return `${allDigits ? '\\d+' : '[^/?#]+'}${m[2] ? escapeRegex(m[2]) : ''}`;
    })
    .join('/');
  return `^/${body}/?$`;
}

/** Path template with {{input}} placeholders: /products/{id} -> /products/{{id}} */
export function patternToPathTemplate(pattern: string): { template: string; inputs: Array<{ name: string; segment: string }> } {
  const path = pattern.split('?')[0] ?? pattern;
  const inputs: Array<{ name: string; segment: string }> = [];
  const segments = path.split('/').filter(Boolean).map((s) => {
    const m = s.match(/^\{(id|slug)\}(\.[a-z0-9]+)?$/i);
    if (!m) return s;
    const base = m[1]!.toLowerCase();
    const name = inputs.length === 0 ? base : `${base}${inputs.length + 1}`;
    inputs.push({ name, segment: s });
    return `{{${name}}}${m[2] ?? ''}`;
  });
  return { template: `/${segments.join('/')}`, inputs };
}
