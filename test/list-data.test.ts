import { describe, expect, it } from 'vitest';
import { extractListData } from '../src/html/listData.js';

const page = (body: string, head = '') => `<!doctype html><html><head><title>Cars</title>${head}</head><body>
<header><a href="/cardetail/promo-1">Promo</a><nav><a href="/cardetail/nav-2">Nav</a></nav></header>
<main>${body}</main>
<footer><a href="/cardetail/footer-3">Footer</a></footer></body></html>`;

describe('extractListData', () => {
  it('returns result links from the main content only, resolved against the page URL and deduplicated', () => {
    const html = page(`<ul>
      <li><a href="/cardetail/toyota-camry-used-1">Toyota Camry 2020</a></li>
      <li><a href="https://a.test/cardetail/kia-sorento-used-2#pos=2">Kia Sorento</a></li>
      <li><a href="/cardetail/kia-sorento-used-2?x=1#other">Kia again</a></li>
      <li><a href="/city/riyadh">Riyadh</a></li>
      <li><a href="https://other.test/cardetail/elsewhere-9">Elsewhere</a></li>
      <li><a href="/autos/toyota">self</a></li>
    </ul>`);
    const data = extractListData(html, { pageUrl: 'https://a.test/autos/toyota', hrefPattern: '^/cardetail/[^/?#]+/?$', maxItems: 10, allowedHosts: ['a.test'] });
    expect(data.results.map((r) => r.url)).toEqual(['https://a.test/cardetail/toyota-camry-used-1', 'https://a.test/cardetail/kia-sorento-used-2', 'https://a.test/cardetail/kia-sorento-used-2?x=1']);
    expect(data.results[0]).toEqual({ title: 'Toyota Camry 2020', url: 'https://a.test/cardetail/toyota-camry-used-1' });
    expect(data.linkCount).toBe(3);
    expect(data.itemListCount).toBe(0);
  });

  it('enriches results with the page ItemList offers and adds entries the links missed', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'Toyota Camry 2020', url: '/cardetail/toyota-camry-used-1', image: ['https://cdn.test/1.jpg'], description: 'A  fine   car', offers: { '@type': 'Offer', price: 59500, priceCurrency: 'SAR', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/UsedCondition' } } },
        { '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'Only in data', url: 'https://a.test/cardetail/only-in-data-5', offers: [{ '@type': 'Offer', price: '12,000', priceCurrency: 'SAR' }] } },
        { '@type': 'ListItem', position: 3, item: { '@type': 'Product', name: 'Not a result', url: '/city/abha' } },
      ],
    });
    const html = page(`<a href="/cardetail/toyota-camry-used-1">Toyota Camry 2020</a>`, `<script type="application/ld+json">${ld}</script>`);
    const data = extractListData(html, { pageUrl: 'https://a.test/autos/toyota', hrefPattern: '^/cardetail/[^/?#]+/?$', maxItems: 10, allowedHosts: ['a.test'] });
    expect(data.itemListCount).toBe(3);
    expect(data.count).toBe(2);
    expect(data.results[0]).toEqual({ title: 'Toyota Camry 2020', url: 'https://a.test/cardetail/toyota-camry-used-1', image: 'https://cdn.test/1.jpg', description: 'A fine car', price: 59500, currency: 'SAR', availability: 'InStock', condition: 'UsedCondition' });
    expect(data.results[1]).toEqual({ title: 'Only in data', url: 'https://a.test/cardetail/only-in-data-5', price: 12000, currency: 'SAR' });
  });

  it('reads ItemList nodes inside a @graph and honours maxItems and the exclude pattern', () => {
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'ItemList', itemListElement: [1, 2, 3].map((i) => ({ '@type': 'ListItem', position: i, name: `Item ${i}`, url: `/items/${i}` })) }] });
    const html = page(`<a href="/items/9">Nine</a><a href="/items/archive">Archive</a>`, `<script type="application/ld+json">${ld}</script>`);
    const data = extractListData(html, { pageUrl: 'https://a.test/items', hrefPattern: '^/items/[^/?#]+$', excludeHrefPattern: '^/items/archive$', maxItems: 2, allowedHosts: ['a.test'] });
    expect(data.linkCount).toBe(1);
    expect(data.itemListCount).toBe(3);
    expect(data.results.map((r) => r.title)).toEqual(['Nine', 'Item 1']);
  });
});
