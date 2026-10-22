import { describe, expect, it } from 'vitest';
import { buildRouteCandidates, parseSitemap } from '../src/stages/stage2-sitemap.js';

describe('parseSitemap', () => {
  it('parses a sitemap index', () => {
    const parsed = parseSitemap('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap><sitemap><loc>https://a.test/s2.xml</loc></sitemap></sitemapindex>', 'application/xml');
    expect(parsed.kind).toBe('index');
    expect(parsed.children).toEqual(['https://a.test/s1.xml', 'https://a.test/s2.xml']);
  });
  it('parses a urlset with CDATA, lastmod and priority', () => {
    const parsed = parseSitemap('﻿<urlset><url><loc><![CDATA[https://a.test/p/1]]></loc><lastmod>2026-01-01</lastmod><priority>0.8</priority><changefreq>daily</changefreq></url><url><loc>https://a.test/p/2</loc></url></urlset>', 'text/xml');
    expect(parsed.kind).toBe('urlset');
    expect(parsed.urls).toEqual([
      { loc: 'https://a.test/p/1', lastmod: '2026-01-01', priority: 0.8, changefreq: 'daily' },
      { loc: 'https://a.test/p/2', lastmod: undefined, priority: undefined, changefreq: undefined },
    ]);
  });
  it('parses plain-text sitemaps and rejects HTML', () => {
    expect(parseSitemap('https://a.test/x\n\nhttps://a.test/y\nnot a url', 'text/plain').urls.map((u) => u.loc)).toEqual(['https://a.test/x', 'https://a.test/y']);
    expect(parseSitemap('<!doctype html><html><body>404</body></html>', 'text/html').kind).toBe('unknown');
  });
});

describe('buildRouteCandidates', () => {
  it('groups by pattern and orders by frequency', () => {
    const routes = buildRouteCandidates(['https://a.test/p/1', 'https://a.test/p/2', 'https://a.test/about', 'https://a.test/p/3'], 2);
    expect(routes[0]).toEqual({ pattern: '/p/{id}', count: 3, examples: ['https://a.test/p/1', 'https://a.test/p/2'] });
    expect(routes[1]?.pattern).toBe('/about');
  });
});
