import { describe, expect, it } from 'vitest';
import { normalizeUrl, wwwCounterpart, registrableDomain, sameSite } from '../src/net/url.js';
import { classifySegment, urlPattern } from '../src/html/templates.js';

describe('normalizeUrl', () => {
  it('lowercases host, drops fragments, default ports and credentials', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path/#frag')).toBe('https://example.com/Path');
    expect(normalizeUrl('http://user:pw@example.com:80/')).toBe('http://example.com/');
  });
  it('removes tracking parameters and sorts the rest', () => {
    expect(normalizeUrl('https://a.com/p?z=1&utm_source=x&a=2&fbclid=abc')).toBe('https://a.com/p?a=2&z=1');
  });
  it('strips trailing slashes except at the root and collapses duplicate slashes', () => {
    expect(normalizeUrl('https://a.com/docs/')).toBe('https://a.com/docs');
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
    expect(normalizeUrl('https://a.com//a//b/')).toBe('https://a.com/a/b');
  });
  it('resolves relative URLs against a base and rejects non-http schemes', () => {
    expect(normalizeUrl('../x?b=1', 'https://a.com/d/e/f')).toBe('https://a.com/d/x?b=1');
    expect(normalizeUrl('mailto:x@y.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)', 'https://a.com')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
  it('keeps query untouched when asked', () => {
    expect(normalizeUrl('https://a.com/p?z=1&utm_source=x', undefined, { keepQuery: true })).toBe('https://a.com/p?z=1&utm_source=x');
  });
});

describe('wwwCounterpart', () => {
  it('maps apex and www forms', () => {
    expect(wwwCounterpart('www.example.com')).toBe('example.com');
    expect(wwwCounterpart('example.com')).toBe('www.example.com');
    expect(wwwCounterpart('shop.example.com')).toBeNull();
  });
});

describe('urlPattern', () => {
  it('generalizes identifier-like segments', () => {
    expect(classifySegment('12345')).toBe('{id}');
    expect(classifySegment('550e8400-e29b-41d4-a716-446655440000')).toBe('{id}');
    expect(classifySegment('deadbeef12')).toBe('{id}');
    expect(classifySegment('red-shoes-2026')).toBe('{slug}');
    expect(classifySegment('item-42')).toBe('{slug}');
    expect(classifySegment('About')).toBe('about');
    expect(classifySegment('post-123.html')).toBe('{slug}.html');
  });
  it('appends sorted query keys', () => {
    expect(urlPattern('https://a.com/products/7?sort=asc&page=2')).toBe('/products/{id}?page,sort');
    expect(urlPattern('https://a.com/')).toBe('/');
  });
});

describe('normalizeUrl for fetching', () => {
  it('keeps trailing slashes and query strings untouched', () => {
    expect(normalizeUrl('https://a.com/docs/?utm_source=x#f', undefined, { keepQuery: true, keepTrailingSlash: true })).toBe('https://a.com/docs/?utm_source=x');
  });
});

describe('registrableDomain and sameSite', () => {
  it('handles two-part public suffixes and sibling hosts', () => {
    expect(registrableDomain('sitemapfiles.haraj.com.sa')).toBe('haraj.com.sa');
    expect(registrableDomain('haraj.com.sa')).toBe('haraj.com.sa');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('cdn.example.com')).toBe('example.com');
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(sameSite('sitemapfiles.haraj.com.sa', 'haraj.com.sa')).toBe(true);
    expect(sameSite('haraj.com.sa', 'other.com.sa')).toBe(false);
  });
});
