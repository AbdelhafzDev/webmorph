import { describe, expect, it } from 'vitest';
import { extractHtmlFacts } from '../src/html/extract.js';
import { classifyRenderMode } from '../src/html/renderMode.js';
import { detectBlockSignal } from '../src/html/blocked.js';
import { extractPageData, hasStructuredData } from '../src/html/pageData.js';
import { ScopePolicy } from '../src/net/scope.js';

const scope = new ScopePolicy({ origin: 'https://shop.test', allowedHosts: ['shop.test'], allowPrivateNetwork: false, respectRobots: true, userAgent: 'x' });

const HTML = `<!doctype html><html lang="en"><head><title>  Red Shoes | Shop </title>
<meta name="description" content="Buy red shoes"><link rel="canonical" href="/products/42/?utm_source=x">
<meta name="robots" content="index,follow">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Red"},{"@type":["BreadcrumbList"]}]}</script>
</head><body>
<nav><a href="/">Home</a><a href="/products/">Products</a><a href="https://other.test/x" rel="nofollow noopener">Other</a><a href="mailto:a@b.c">mail</a><a href="#top">top</a></nav>
<form role="search" action="/search" method="get"><input type="text" name="q"><button type="submit">Go</button></form>
<form id="login" action="/login" method="post"><label for="u">Username</label><input id="u" name="u"><input type="password" name="pw" required><input type="submit" value="Sign in"></form>
<form action="/filter" method="get"><select name="color"><option>red</option><option>blue</option></select><input type="checkbox" name="sale"></form>
<main><h1>Red Shoes</h1><h2>Details</h2><p>${'Lovely shoes. '.repeat(40)}</p></main>
<script src="/_next/static/chunks/main.js"></script><script>window.__NEXT_DATA__={}</script>
</body></html>`;

describe('extractHtmlFacts', () => {
  const facts = extractHtmlFacts(HTML, { finalUrl: 'https://shop.test/products/42', scope, maxLinks: 100 });

  it('reads metadata and normalizes the canonical URL', () => {
    expect(facts.title).toBe('Red Shoes | Shop');
    expect(facts.lang).toBe('en');
    expect(facts.description).toBe('Buy red shoes');
    expect(facts.canonical).toBe('https://shop.test/products/42');
    expect(facts.robotsMeta).toBe('index,follow');
    expect(facts.headings).toEqual([{ level: 1, text: 'Red Shoes' }, { level: 2, text: 'Details' }]);
  });
  it('collects links with scope and nofollow flags and skips non-http hrefs', () => {
    expect(facts.links.map((l) => l.href)).toEqual(['https://shop.test/', 'https://shop.test/products', 'https://other.test/x']);
    expect(facts.links[2]).toMatchObject({ inScope: false, nofollow: true });
    expect(facts.internalLinkCount).toBe(2);
    expect(facts.externalLinkCount).toBe(1);
  });
  it('classifies forms and their side-effect hints', () => {
    expect(facts.forms.map((f) => [f.classification, f.sideEffectHint, f.method])).toEqual([
      ['search', 'read', 'get'],
      ['login', 'write', 'post'],
      ['filter', 'read', 'get'],
    ]);
    const login = facts.forms[1]!;
    expect(login.hasPassword).toBe(true);
    expect(login.submitText).toBe('Sign in');
    expect(login.fields.find((f) => f.name === 'u')?.label).toBe('Username');
    expect(login.fields.find((f) => f.name === 'pw')?.required).toBe(true);
    expect(facts.forms[2]!.fields[0]).toMatchObject({ type: 'select', optionCount: 2 });
  });
  it('detects frameworks, JSON-LD types and render mode', () => {
    expect(facts.scripts.frameworks).toEqual(['next']);
    expect(facts.jsonLdTypes).toEqual(['BreadcrumbList', 'Product']);
    expect(facts.renderMode.kind).toBe('hybrid');
    expect(facts.textLength).toBeGreaterThan(400);
    expect(facts.skeletonHash).toMatch(/^[0-9a-f]{12}$/);
  });
  it('produces the same skeleton hash for structurally identical pages with different text', () => {
    const other = extractHtmlFacts(HTML.replace(/Red Shoes/g, 'Blue Hat').replace('Lovely shoes.', 'Great hat.'), { finalUrl: 'https://shop.test/products/43', scope, maxLinks: 100 });
    expect(other.skeletonHash).toBe(facts.skeletonHash);
  });
});

describe('classifyRenderMode', () => {
  it('flags an empty mount node with scripts as an SPA shell', () => {
    const spa = extractHtmlFacts('<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>', { finalUrl: 'https://shop.test/app', scope, maxLinks: 10 });
    expect(spa.renderMode.kind).toBe('spa-shell');
    expect(spa.scripts.hasRootMount).toBe(true);
  });
  it('treats text-rich pages without frameworks as static', () => {
    expect(classifyRenderMode({ htmlLength: 5000, textLength: 2000, scriptCount: 1, internalLinkCount: 10, frameworks: [], hasRootMount: false }).kind).toBe('static');
  });
});

describe('detectBlockSignal', () => {
  it('recognizes common protections', () => {
    expect(detectBlockSignal(403, { server: 'cloudflare' }, '<title>Just a moment...</title>')).toBe('cloudflare-challenge');
    expect(detectBlockSignal(403, { server: 'cloudflare' }, 'nope')).toBe('cloudflare-403');
    expect(detectBlockSignal(429, {}, '')).toBe('rate-limited');
    expect(detectBlockSignal(403, { server: 'AkamaiGHost' }, 'Access Denied')).toBe('akamai-access-denied');
    expect(detectBlockSignal(200, {}, '<h1>Welcome</h1>')).toBeNull();
    expect(detectBlockSignal(403, {}, '<p>You do not have permission to view this page.</p>')).toBeNull();
  });
});

describe('classifyRenderMode on small static pages', () => {
  it('does not call a tiny page with an analytics script an SPA shell', () => {
    const r = classifyRenderMode({ htmlLength: 577, textLength: 156, scriptCount: 1, internalLinkCount: 0, frameworks: [], hasRootMount: false });
    expect(r.kind).toBe('static');
  });
  it('calls a framework page with almost no text a shell', () => {
    const r = classifyRenderMode({ htmlLength: 3000, textLength: 40, scriptCount: 4, internalLinkCount: 0, frameworks: ['react'], hasRootMount: false });
    expect(r.kind).toBe('spa-shell');
  });
});

describe('extractPageData', () => {
  it('collects JSON-LD, breadcrumbs, Open Graph tags and embedded JSON state', () => {
    const html = `<html><head><title>Camry wheels</title><meta name="description" content="Four wheels"><meta property="og:title" content="Camry wheels"><meta property="product:price:amount" content="1700">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"Camry wheels","image":["a.jpg"]}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"/tags/cars","name":"Cars"}},{"@type":"ListItem","position":2,"name":"Toyota"}]}</script>
<script type="application/ld+json">{"@type":"WebSite","url":"https://x.test"}</script>
<script id="__STATE__" type="application/json">{"post":{"id":1,"price":1700}}</script>
<script>window.__INITIAL__ = {"user":null,"locale":"en"};</script>
<script>window.__reactRouterContext.streamController.enqueue("[1,2]");</script>
</head><body></body></html>`;
    const d = extractPageData(html);
    expect(d.title).toBe('Camry wheels');
    expect(d.description).toBe('Four wheels');
    expect(d.og).toMatchObject({ 'og:title': 'Camry wheels', 'product:price:amount': '1700' });
    expect(d.jsonLdTypes).toEqual(['Thing', 'BreadcrumbList', 'WebSite']);
    expect(d.breadcrumbs).toEqual(['Cars', 'Toyota']);
    expect(d.embedded).toEqual({ __STATE__: { post: { id: 1, price: 1700 } }, __INITIAL__: { user: null, locale: 'en' } });
    expect(hasStructuredData(d)).toBe(true);
    expect(hasStructuredData(extractPageData('<html><head><title>x</title><script type="application/ld+json">{"@type":"WebSite"}</script></head></html>'))).toBe(false);
  });
});
