import { describe, expect, it } from 'vitest';
import { buildFamilyIndex, buildTemplates, classifyTemplate, generalizePatterns } from '../src/html/templates.js';
import type { PageRecord } from '../src/schemas/pageInventory.js';

function page(url: string, skeletonHash: string, extra: Partial<NonNullable<PageRecord['html']>> = {}): PageRecord {
  return {
    requestedUrl: url,
    finalUrl: url,
    redirectChain: [],
    status: 200,
    contentType: 'text/html',
    depth: 1,
    discoveredVia: 'link',
    fetchedAt: new Date().toISOString(),
    durationMs: 1,
    outcome: 'ok',
    html: {
      headings: [],
      htmlLength: 100,
      textLength: 50,
      textSample: '',
      links: [],
      internalLinkCount: 0,
      externalLinkCount: 0,
      linksTruncated: false,
      forms: [],
      scripts: { count: 0, externalCount: 0, frameworks: [], hasRootMount: false },
      jsonLdTypes: [],
      renderMode: { kind: 'static', textDensity: 0.5, reasons: [] },
      skeletonHash,
      ...extra,
    },
  };
}

describe('generalizePatterns', () => {
  it('collapses literal siblings that share a skeleton into {slug}', () => {
    const pages = ['intro', 'install', 'config', 'api'].map((s) => ({ url: `https://a.test/docs/${s}`, skeletonHash: 'doc', depth: 1 }));
    const result = generalizePatterns(pages);
    expect(new Set(result.values())).toEqual(new Set(['/docs/{slug}']));
  });
  it('leaves top-level pages with different skeletons alone', () => {
    const pages = [
      { url: 'https://a.test/about', skeletonHash: 'h1', depth: 1 },
      { url: 'https://a.test/pricing', skeletonHash: 'h2', depth: 1 },
      { url: 'https://a.test/contact', skeletonHash: 'h3', depth: 1 },
      { url: 'https://a.test/careers', skeletonHash: 'h4', depth: 1 },
    ];
    const result = generalizePatterns(pages);
    expect(Array.from(result.values()).sort()).toEqual(['/about', '/careers', '/contact', '/pricing']);
  });
  it('keeps numeric identifiers generalized and preserves query keys', () => {
    const result = generalizePatterns([
      { url: 'https://a.test/products/1', skeletonHash: 'p', depth: 1 },
      { url: 'https://a.test/products/2?ref=x', skeletonHash: 'p', depth: 1 },
    ]);
    expect(result.get('https://a.test/products/1')).toBe('/products/{id}');
    expect(result.get('https://a.test/products/2?ref=x')).toBe('/products/{id}?ref');
  });
});

describe('classifyTemplate', () => {
  it('maps patterns and page facts to kinds', () => {
    expect(classifyTemplate('/', []).kind).toBe('home');
    expect(classifyTemplate('/docs/{slug}', []).kind).toBe('documentation');
    expect(classifyTemplate('/login', []).kind).toBe('auth');
    expect(classifyTemplate('/search?q', []).kind).toBe('search');
    expect(classifyTemplate('/products/{id}', []).kind).toBe('detail');
    expect(classifyTemplate('/blog/{slug}', []).kind).toBe('article');
    expect(classifyTemplate('/products', []).kind).toBe('listing');
    expect(classifyTemplate('/privacy', []).kind).toBe('legal');
    expect(classifyTemplate('/account/settings', []).kind).toBe('account');
    expect(classifyTemplate('/team', []).kind).toBe('other');
  });
  it('uses a password form as auth evidence', () => {
    const p = page('https://a.test/members', 'x', {
      forms: [{ action: 'https://a.test/s', method: 'post', fields: [{ type: 'password', required: true }], hasPassword: true, classification: 'login', sideEffectHint: 'write' }],
    });
    expect(classifyTemplate('/members', [p]).kind).toBe('auth');
  });
  it('treats pages whose links mostly point at detail pages as listings', () => {
    const p = page('https://a.test/featured', 'x', {
      links: [1, 2, 3, 4].map((i) => ({ href: `https://a.test/items/${i}`, text: '', inScope: true, nofollow: false })),
    });
    expect(classifyTemplate('/featured', [p]).kind).toBe('listing');
  });
  it('classifies a generalized /section/{slug} template as a listing when its pages declare an ItemList', () => {
    const brand = (name: string) => page(`https://a.test/en/autos/${name}`, 'x', { jsonLdTypes: ['BreadcrumbList', 'ItemList', 'Product'] });
    const result = classifyTemplate('/en/autos/{slug}', [brand('bmw'), brand('byd')]);
    expect(result.kind).toBe('listing');
    expect(result.reasons[0]).toContain('ItemList');
    // A detail page with its own Product markup stays a detail page.
    expect(classifyTemplate('/en/cardetail/{slug}', [page('https://a.test/en/cardetail/x-1', 'y', { jsonLdTypes: ['Car', 'Offer'] })]).kind).toBe('detail');
  });
  it('classifies a /section/{slug} template whose pages link many times to another identifier pattern as a listing', () => {
    const cars = (n: number) => Array.from({ length: n }, (_, i) => ({ href: `https://a.test/cardetail/car-used-${1000 + i}`, text: '', inScope: true, nofollow: false }));
    const listing = page('https://a.test/autos/used-cars', 'x', { links: cars(16) });
    expect(classifyTemplate('/autos/{slug}', [listing]).kind).toBe('listing');
    // A car page with a handful of "related" links is still a detail page.
    const related = page('https://a.test/cardetail/car-used-5', 'y', { links: cars(4) });
    expect(classifyTemplate('/cardetail/{slug}', [related]).kind).toBe('detail');
  });
});

describe('buildTemplates', () => {
  it('groups pages, picks representatives and reports cohesion', () => {
    const pages = [
      page('https://a.test/', 'home'),
      ...[1, 2, 3].map((i) => page(`https://a.test/products/${i}`, 'prod')),
      page('https://a.test/products/4', 'odd'),
    ];
    const templates = buildTemplates(pages, { representatives: 2 });
    const detail = templates.find((t) => t.urlPattern === '/products/{id}')!;
    expect(detail.kind).toBe('detail');
    expect(detail.pageCount).toBe(4);
    expect(detail.cohesion).toBe(0.75);
    expect(detail.representativeUrls).toHaveLength(2);
    expect(detail.representativeUrls.every((u) => u !== 'https://a.test/products/4')).toBe(true);
    expect(templates.find((t) => t.urlPattern === '/')?.kind).toBe('home');
  });
});

describe('classifyTemplate documentation segments', () => {
  it('recognizes docs sections nested under a language prefix', () => {
    expect(classifyTemplate('/python/docs/intro', []).kind).toBe('documentation');
    expect(classifyTemplate('/java/docs/{slug}', []).kind).toBe('documentation');
  });
});

describe('generalizePatterns with a known family', () => {
  it('collapses two crawled siblings when the inventory proves the family is large', () => {
    const familySize = buildFamilyIndex(['bmw', 'kia', 'ford', 'byd', 'gmc'].map((m) => `https://a.test/en/autos/${m}`));
    expect(familySize(['en', 'autos'])).toBe(5);
    expect(familySize(['en', 'nope'])).toBe(0);
    const pages = [
      { url: 'https://a.test/en/autos/bmw', skeletonHash: 'brand', depth: 1 },
      { url: 'https://a.test/en/autos/kia', skeletonHash: 'brand', depth: 1 },
    ];
    expect(new Set(generalizePatterns(pages).values())).toEqual(new Set(['/en/autos/bmw', '/en/autos/kia']));
    expect(new Set(generalizePatterns(pages, { familySize }).values())).toEqual(new Set(['/en/autos/{slug}']));
  });
  it('collapses non-leaf literals under a large declared family', () => {
    const makes = ['toyota', 'kia', 'ford', 'bmw', 'byd', 'gmc', 'mg', 'jeep', 'audi'];
    const models = ['camry', 'corolla', 'yaris', 'rav4', 'hilux', 'prado', 'avalon', 'supra', 'sienna'];
    const familySize = buildFamilyIndex(makes.flatMap((m) => [`https://a.test/autos/${m}`, `https://a.test/autos/${m}/2024`, ...models.map((model) => `https://a.test/autos/${m}/${model}/2024`)]));
    const pages = [
      { url: 'https://a.test/autos/toyota/2024', skeletonHash: 'year', depth: 2 },
      { url: 'https://a.test/autos/kia/sorento/2023', skeletonHash: 'year', depth: 3 },
    ];
    expect(new Set(generalizePatterns(pages, { familySize }).values())).toEqual(new Set(['/autos/{slug}/{id}', '/autos/{slug}/{slug}/{id}']));
    // Without the inventory the literal makes stay literal.
    expect(new Set(generalizePatterns(pages).values())).toEqual(new Set(['/autos/toyota/{id}', '/autos/kia/sorento/{id}']));
  });
  it('never collapses top-level sections, even behind a locale prefix', () => {
    const sections = ['autos', 'cardetail', 'city', 'trend', 'years', 'financing', 'prices', 'products', 'car-countries'];
    const makes = ['toyota', 'kia', 'ford', 'bmw', 'byd', 'gmc', 'mg', 'jeep', 'audi'];
    const familySize = buildFamilyIndex([...sections.map((s) => `https://a.test/en/${s}/x`), ...makes.flatMap((m) => [`https://a.test/en/autos/${m}`, `https://a.test/en/autos/${m}/2024`])]);
    const pages = [
      { url: 'https://a.test/en/autos/toyota/2024', skeletonHash: 'year', depth: 2 },
      { url: 'https://a.test/en/city/abha', skeletonHash: 'city', depth: 2 },
      { url: 'https://a.test/en/cardetail/car-used-1', skeletonHash: 'car', depth: 2 },
    ];
    expect(new Set(generalizePatterns(pages, { familySize }).values())).toEqual(new Set(['/en/autos/{slug}/{id}', '/en/city/abha', '/en/cardetail/{slug}']));
  });
  it('still requires the crawled members to share a skeleton', () => {
    const familySize = buildFamilyIndex(['a', 'b', 'c', 'd'].map((m) => `https://a.test/x/${m}`));
    const pages = [
      { url: 'https://a.test/x/a', skeletonHash: 'one', depth: 1 },
      { url: 'https://a.test/x/b', skeletonHash: 'two', depth: 1 },
    ];
    expect(new Set(generalizePatterns(pages, { familySize }).values())).toEqual(new Set(['/x/a', '/x/b']));
  });
});

describe('generalizePatterns root-level guard', () => {
  it('does not collapse many distinct top-level pages into one template', () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ url: `https://a.test/page-${String.fromCharCode(97 + i)}`, skeletonHash: `h${i}`, depth: 1 }));
    const result = generalizePatterns(pages);
    expect(new Set(result.values()).size).toBe(12);
  });
  it('still collapses many same-skeleton siblings under a section', () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ url: `https://a.test/docs/topic${String.fromCharCode(97 + i)}`, skeletonHash: 'doc', depth: 2 }));
    expect(new Set(generalizePatterns(pages).values())).toEqual(new Set(['/docs/{slug}']));
  });
});

describe('buildTemplates placeholder merge', () => {
  it('treats /{id}/{slug} and /{id}/{id} as one template', () => {
    const pages = [page('https://a.test/11001/red-shoes-2026', 'post'), page('https://a.test/11002/blue-hat-2026', 'post'), page('https://a.test/11003/20200', 'post')];
    const templates = buildTemplates(pages);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ urlPattern: '/{id}/{slug}', pageCount: 3 });
  });
});
