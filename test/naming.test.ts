import { describe, expect, it } from 'vitest';
import { entityFromPattern } from '../src/model/naming.js';
import { disambiguateByLocale } from '../src/model/facts.js';
import { classifySegment, urlPattern } from '../src/html/templates.js';
import { interleaveByShape, urlShape } from '../src/stages/stage3-crawl.js';
import type { Capability } from '../src/schemas/websiteModel.js';

describe('entityFromPattern', () => {
  it('names the entity after the segment before the identifier', () => {
    expect(entityFromPattern('/products/{id}')).toMatchObject({ singular: 'product', plural: 'products' });
  });
  it('drops a "detail(s)" page suffix from the segment', () => {
    expect(entityFromPattern('/en/cardetail/{slug}')).toMatchObject({ singular: 'car', plural: 'cars' });
    expect(entityFromPattern('/product-details/{id}')).toMatchObject({ singular: 'product', plural: 'products' });
    expect(entityFromPattern('/details/{id}')).toMatchObject({ singular: 'detail', plural: 'details' });
  });
});

describe('classifySegment', () => {
  it('keeps API and route versions literal', () => {
    expect(classifySegment('syarah_v1')).toBe('syarah_v1');
    expect(classifySegment('api-v2')).toBe('api-v2');
    expect(classifySegment('v3')).toBe('v3');
    expect(urlPattern('https://a.test/api/syarah_v1/en/post/view-online')).toBe('/api/syarah_v1/en/post/view-online');
  });
  it('still generalizes hyphenated identifiers with digits', () => {
    expect(classifySegment('bmw-7-series-used-298546')).toBe('{slug}');
    expect(classifySegment('298546')).toBe('{id}');
  });
});

describe('urlShape / interleaveByShape', () => {
  it('keys by depth and leading section, skipping a locale prefix', () => {
    expect(urlShape('https://a.test/en/autos/bmw')).toBe('3:en/autos');
    expect(urlShape('https://a.test/en/autos/toyota/corolla')).toBe('4:en/autos');
    expect(urlShape('https://a.test/en/cardetail/x-1')).toBe('3:en/cardetail');
    expect(urlShape('https://a.test/products/1')).toBe('2:products');
    // Top-level one-off pages share a shape so a small budget is not spent visiting each of them first.
    expect(urlShape('https://a.test/about')).toBe('1:*');
    expect(urlShape('https://a.test/compare')).toBe('1:*');
    expect(urlShape('https://a.test/en/faq')).toBe('2:en/*');
    expect(urlShape('https://a.test/')).toBe('0:*');
  });
  it('interleaves items so consecutive picks come from different shapes', () => {
    const urls = ['https://a.test/autos/a', 'https://a.test/autos/b', 'https://a.test/autos/c', 'https://a.test/city/x', 'https://a.test/city/y', 'https://a.test/cardetail/z-1'];
    const out = interleaveByShape(urls, (u) => u);
    expect(out.slice(0, 3)).toEqual(['https://a.test/autos/a', 'https://a.test/city/x', 'https://a.test/cardetail/z-1']);
    expect(out).toHaveLength(urls.length);
  });
});

function cap(name: string, navigateUrl: string, pathTemplate?: string): Capability {
  return {
    capabilityId: `cap-${name}`,
    kind: 'search',
    name,
    title: name,
    description: '',
    status: 'observed',
    confidence: 0.5,
    pageUrl: navigateUrl,
    inputs: [],
    outputs: [],
    preconditions: [],
    expectedOutcome: '',
    sideEffectClass: 'read',
    authRequirement: 'none',
    mechanics: { navigateUrl, ...(pathTemplate ? { pathTemplate } : {}), queryParams: {} },
    evidence: [],
  };
}

describe('disambiguateByLocale', () => {
  it('replaces numeric suffixes with the locale when variants differ only by locale prefix', () => {
    const caps = [cap('search_cars', 'https://a.test/en/filters'), cap('search_cars_2', 'https://a.test/filters'), cap('search_cars_3', 'https://a.test/ar/filters')];
    disambiguateByLocale(caps, 'https://a.test/');
    expect(caps.map((c) => c.name)).toEqual(['search_cars_en', 'search_cars', 'search_cars_ar']);
  });
  it('keeps the base name on the variant matching the start URL locale', () => {
    const caps = [cap('search_cars', 'https://a.test/en/filters'), cap('search_cars_2', 'https://a.test/ar/filters')];
    disambiguateByLocale(caps, 'https://a.test/ar/');
    expect(caps.map((c) => c.name)).toEqual(['search_cars_en', 'search_cars']);
  });
  it('leaves numeric suffixes alone when the variants share a locale', () => {
    const caps = [cap('list_cars', 'https://a.test/en/a'), cap('list_cars_2', 'https://a.test/en/b')];
    disambiguateByLocale(caps, 'https://a.test/');
    expect(caps.map((c) => c.name)).toEqual(['list_cars', 'list_cars_2']);
  });
});
