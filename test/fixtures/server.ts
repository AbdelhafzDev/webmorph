import http from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

export interface FixtureOptions {
  /** Every HTML route answers with a Cloudflare-style challenge. */
  blockAll?: boolean;
}

export type FixtureMode = 'normal' | 'broken-results' | 'search-moved';

export interface FixtureSite {
  baseUrl: string;
  port: number;
  requests: string[];
  posts: string[];
  /** GraphQL operations the server executed, by type. */
  graphql: Array<{ operationName?: string; type: 'query' | 'mutation' }>;
  /** Calls to the keyed API (/api/keyed/products): whether each carried the expected bearer key. */
  keyedCalls: Array<'authorized' | 'unauthorized'>;
  /** Consequential purchases from the /app single-page app. Must stay empty under WebMorph. */
  buys: string[];
  /** Calls to the public events feed (/api/events): whether each carried the widget's session-like cookie. */
  eventCalls: Array<'with-cookie' | 'without-cookie'>;
  /** Change behavior at runtime to simulate the site changing under a validated tool. */
  setMode(mode: FixtureMode): void;
  close(): Promise<void>;
}

const nav = (base: string) => `
<header><nav>
  <a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a>
  <a href="/docs/intro">Docs</a> <a href="/blog/hello-world-2026">Blog</a>
  <a href="/login">Login</a> <a href="/contact">Contact</a>
  <a href="${base}/redirect-in">Alias</a> <a href="/redirect-out">Partner</a>
  <a href="/spa">App</a> <a href="/image.png">Logo</a> <a href="/blocked">Members</a>
  <a href="/loop1">Loop</a> <a href="/retry">Flaky</a> <a href="/big">Big</a>
  <a href="/private/secret">Secret</a> <a href="https://external.example/">External</a>
  <a href="mailto:x@example.com">Mail</a> <a href="javascript:void(0)">JS</a> <a href="#top">Top</a>
  <a href="/about?utm_source=nav&utm_medium=header">About (tracked)</a>
</nav>
<form role="search" action="/search" method="get"><input type="search" name="q" placeholder="Search products" data-testid="search-input"><button type="submit">Search</button></form>
</header>`;

const page = (base: string, title: string, body: string, extraHead = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} page">${extraHead}</head>
<body>${nav(base)}<main>${body}</main><footer><p>Fixture Shop Inc. All rights reserved. <a href="/privacy">Privacy</a></p></footer>
<script src="/analytics.js"></script><script src="https://external.example/tracker.js"></script></body></html>`;

const products = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: (i + 1) * 10 }));

/** A section nothing links to: only a crawl that starts at /cars finds it, so the other fixture crawls stay unchanged. */
const cars = [
  { id: 101, slug: 'toyota-camry-2020-1', title: 'Toyota Camry 2020', make: 'Toyota', model: 'Camry', year: 2020, price: 59500, mileage: 120000 },
  { id: 102, slug: 'honda-accord-2019-2', title: 'Honda Accord 2019', make: 'Honda', model: 'Accord', year: 2019, price: 48000, mileage: 90000 },
];

/** Page state as a framework inlines it: nested objects, an array of objects, null, booleans, and credential-like keys a tool must name but never describe. */
const carPageData = (c: (typeof cars)[number]) => ({
  post: {
    id: c.id,
    slug: c.slug,
    title: c.title,
    price: { amount: c.price, currency: 'SAR' },
    specs: { make: c.make, model: c.model, year: c.year, mileage: c.mileage, fuel: 'petrol', transmission: 'automatic' },
    gallery: ['/image.png', '/image.png'],
    featured: false,
    soldAt: null,
  },
  seller: { name: 'Fixture Motors', phone: '+966500000000', rating: 4.5 },
  session: { token: 'visitor-secret-0001', expires: 1760000000 },
  similar: cars.filter((o) => o !== c).map((o) => ({ slug: o.slug, title: o.title, price: o.price })),
  flags: { verified: true, premium: false },
});

/** The publishable key the keyed search API expects, as a site would ship it in its JavaScript bundle. */
export const KEYED_API_KEY = 'Bearer test-key';

/**
 * A section nothing links to, reached only by a crawl that starts at /events. The listing page sets a cookie named
 * like a session (what a third-party chat widget does), so the browser sends it with every XHR the page makes; the
 * endpoints differ in what they need: the feed is public, "mine" needs the cookie, "digest" needs a bearer token.
 */
export const EVENTS_WIDGET_COOKIE = 'sessionId';
export const EVENTS_DIGEST_TOKEN = 'Bearer events-digest-token';
const events = [
  { id: 1, title: 'Fixture Expo 2026', date: '2026-11-03', venue: 'Hall A' },
  { id: 2, title: 'Crawler Meetup', date: '2026-11-10', venue: 'Room 2' },
  { id: 3, title: 'Schema Summit', date: '2026-11-17', venue: 'Main stage' },
];

export async function startFixtureSite(options: FixtureOptions = {}): Promise<FixtureSite> {
  const requests: string[] = [];
  const posts: string[] = [];
  const graphql: Array<{ operationName?: string; type: 'query' | 'mutation' }> = [];
  const keyedCalls: Array<'authorized' | 'unauthorized'> = [];
  const buys: string[] = [];
  const eventCalls: Array<'with-cookie' | 'without-cookie'> = [];
  let retryHits = 0;
  let flakyHits = 0;
  let mode: FixtureMode = 'normal';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    if (req.method === 'POST' && url.pathname !== '/graphql') posts.push(url.pathname); // GraphQL queries are reads; mutations are tracked in graphql[]
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const hasWidgetCookie = () => (req.headers['cookie'] ?? '').split(';').some((c) => c.trim().startsWith(`${EVENTS_WIDGET_COOKIE}=`));
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      if (options.blockAll) {
        return send(403, 'text/html', '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>', { server: 'cloudflare', 'cf-mitigated': 'challenge' });
      }
      return send(status, 'text/html; charset=utf-8', body, headers);
    };

    switch (url.pathname) {
      case '/robots.txt':
        return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\nSitemap: ${base}/sitemap_index.xml\n`);
      case '/sitemap_index.xml':
        return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-products.xml.gz</loc></sitemap>
</sitemapindex>`);
      case '/sitemap-pages.xml':
        return send(200, 'text/xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><priority>1.0</priority></url>
  <url><loc><![CDATA[${base}/about]]></loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>${base}/search?q=shoes</loc></url>
  <url><loc>${base}/docs/intro</loc></url>
  <url><loc>${base}/docs/install</loc></url>
  <url><loc>${base}/docs/config</loc></url>
  <url><loc>${base}/docs/api</loc></url>
  <url><loc>${base}/private/secret</loc></url>
  <url><loc>${base}/login</loc></url>
  <url><loc>https://external.example/out</loc></url>
</urlset>`);
      case '/sitemap-products.xml.gz': {
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${products
          .map((p) => `<url><loc>${base}/products/${p.id}</loc><lastmod>2026-10-01</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`)
          .join('')}</urlset>`;
        return send(200, 'application/gzip', gzipSync(Buffer.from(xml)));
      }
      case '/':
        return html(200, page(base, 'Fixture Shop', `<div role="dialog" aria-modal="true" aria-label="Cookie consent" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:8px"><p>We use cookies to run this fixture.</p><button type="button">Accept all</button><button type="button">Decline</button></div>
<img src="/image.png" alt="Logo" width="8" height="8"><iframe src="https://external.example/embed" title="Partner widget" width="10" height="10"></iframe>
<a href="/strict/">Strict section</a> <a href="/latin1">Latin page</a> <a href="/find-page">Find</a>
<div><div><div><div><div><div><div><div><div><div><button type="button" aria-expanded="false" aria-label="">➕</button></div></div></div></div></div></div></div></div></div></div>
<div><div><div><div><div><div><div><div><div><div><button type="button" aria-expanded="false" aria-label="">➕</button></div></div></div></div></div></div></div></div></div></div>
<button id="wish-btn" type="button" aria-expanded="false">Show more</button>
<script>document.getElementById('wish-btn').addEventListener('click', function () { this.setAttribute('aria-expanded', 'true'); fetch('/api/wishlist', { method: 'POST', body: '{}' }).catch(function () {}); });</script>
<button id="menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="site-menu">Menu</button>
<ul id="site-menu" hidden><li><a href="/about">About the shop</a></li><li><a href="/products">All products</a></li></ul>
<details><summary>More about shipping</summary><p>We ship fixtures worldwide, usually within one simulated business day.</p></details>
<div role="tablist" aria-label="Info tabs"><button type="button" role="tab" id="tab-one" aria-selected="true" aria-controls="panel-one">Overview</button><button type="button" role="tab" id="tab-two" aria-selected="false" aria-controls="panel-two">Specifications</button></div>
<div id="panel-one" role="tabpanel">Overview panel text.</div><div id="panel-two" role="tabpanel" hidden>Specifications panel with considerably more text to change the page state.</div>
<script>
document.getElementById('menu-btn').addEventListener('click', function () { var open = this.getAttribute('aria-expanded') === 'true'; this.setAttribute('aria-expanded', String(!open)); document.getElementById('site-menu').hidden = open; });
document.querySelectorAll('[role=tab]').forEach(function (t) { t.addEventListener('click', function () { document.querySelectorAll('[role=tab]').forEach(function (o) { o.setAttribute('aria-selected', 'false'); }); t.setAttribute('aria-selected', 'true'); document.querySelectorAll('[role=tabpanel]').forEach(function (p) { p.hidden = p.id !== t.getAttribute('aria-controls'); }); }); });
</script>
<h1>Welcome to Fixture Shop</h1><p>We sell six excellent products. Browse the catalog, read the docs, or search above. This paragraph exists so the homepage has enough text to count as content rather than a shell.</p><ul>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`).join('')}</ul>`, `<link rel="canonical" href="${base}/">`));
      case '/about':
        return html(200, page(base, 'About', '<h1>About us</h1><p>Fixture Shop was founded to give crawlers something to crawl. We have a long and distinguished history of serving test fixtures to integration suites across the world.</p>'));
      case '/privacy':
        return html(200, page(base, 'Privacy', '<h1>Privacy policy</h1><p>We collect nothing. This page is a legal document for the purposes of template classification tests.</p>'));
      case '/cars':
        return html(200, page(base, 'Cars', `<h1>Cars</h1><ul class="grid">${cars.map((c) => `<li><a href="/cars/${c.slug}">${c.title}</a></li>`).join('')}</ul><p>Two used cars, listed so a crawl that starts here finds a detail family whose pages inline their state as JSON.</p>`));
      case '/products': {
        const pageNo = Number(url.searchParams.get('page') ?? '1');
        const sort = url.searchParams.get('sort') ?? 'asc';
        const ordered = sort === 'desc' ? [...products].reverse() : products;
        const slice = pageNo === 1 ? ordered.slice(0, 3) : ordered.slice(3);
        return html(200, page(base, `Products page ${pageNo}`, `<h1>Products</h1>
<form id="sort-form" method="get" action="/products"><label for="sort">Sort by</label><select id="sort" name="sort"><option value="asc"${sort === 'asc' ? ' selected' : ''}>Price ascending</option><option value="desc"${sort === 'desc' ? ' selected' : ''}>Price descending</option></select><button type="submit">Apply</button></form>
<ul class="grid">${slice.map((p) => `<li><a href="/products/${p.id}">${p.name}</a> $${p.price}</li>`).join('')}</ul>
<nav aria-label="Pagination"><a rel="next" href="/products?page=${pageNo === 1 ? 2 : 1}">Next</a></nav>`, `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: slice.map((p, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: p.name, url: `/products/${p.id}`, image: `${base}/img/${p.id}.jpg`, offers: { '@type': 'Offer', price: p.price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } } })) })}</script>`));
      }
      case '/search': {
        if (mode === 'search-moved') return html(404, page(base, 'Not found', '<h1>404</h1><p>Search has moved.</p>'));
        const q = url.searchParams.get('q') ?? '';
        const hits = products.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
        const items = mode === 'broken-results' ? hits.map((p) => `<li><span class="result">${p.name}</span></li>`) : hits.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`);
        return html(200, page(base, `Search: ${q}`, `<h1>Results for "${q}"</h1><ol>${items.join('')}</ol><p>Try another search term using the form above.</p><p>API count: <span id="api-count">?</span></p><script>fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'SearchPosts', query: 'query SearchPosts($q: String!) { posts(q: $q) { id title price } }', variables: { q: ${JSON.stringify(q)} } }) }).catch(function () {});
fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'AddFav', query: 'mutation AddFav { addFav(id: 1) { ok } }' }) }).catch(function () {});
fetch('/api/products?q=' + encodeURIComponent(${JSON.stringify(q)}), { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (items) { document.getElementById('api-count').textContent = String(items.length); }).catch(function () {});</script>`));
      }
      case '/login':
        return html(200, page(base, 'Login', '<h1>Sign in</h1><form action="/session" method="post"><label for="e">Email</label><input id="e" type="email" name="email" required><label for="p">Password</label><input id="p" type="password" name="password" required><button type="submit">Sign in</button></form>'));
      case '/contact':
        return html(200, page(base, 'Contact', '<h1>Contact us</h1><form id="contact" action="/contact" method="post"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>'));
      case '/trail':
        res.writeHead(301, { location: '/trail/' });
        return res.end();
      case '/trail/':
        return html(200, page(base, 'Trail', '<h1>Trailing slash</h1><p>Servers often redirect to a trailing slash; the client must follow it verbatim instead of looping. This paragraph makes the page look like content.</p>'));
      case '/llms.txt':
        return send(200, 'text/markdown', `# Fixture Shop\n\n> A tiny demo shop used by WebMorph tests.\n\n## Docs\n- [Intro](/docs/intro): Getting started\n- [API reference](/openapi.json): OpenAPI description of the JSON API\n\n## Products\n- [Catalog](/products): All products\n`);
      case '/openapi.json':
        return send(200, 'application/json', JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Fixture Shop API', version: '1.0.0' },
          servers: [{ url: `${base}/api` }],
          components: {
            securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' } },
            schemas: { Product: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' } } } },
          },
          paths: {
            '/products': { get: { operationId: 'listProducts', summary: 'List or search products', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } } } } },
            '/products/{id}': { get: { operationId: 'getProduct', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } }, '404': { description: 'missing' } } } },
            '/wishlist': { post: { operationId: 'addToWishlist', security: [{ cookieAuth: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '201': { description: 'created' } } } },
            '/account': { get: { operationId: 'getAccount', security: [{ cookieAuth: [] }], responses: { '200': { description: 'ok' } } } },
          },
        }));
      case '/graphql': {
        if (req.method !== 'POST') return send(405, 'application/json', '{"error":"POST only"}');
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        req.on('end', () => {
          let body: { query?: string; operationName?: string; variables?: { q?: string } } = {};
          try { body = JSON.parse(raw); } catch { /* ignore */ }
          const isMutation = /^\s*mutation/.test(body.query ?? '');
          graphql.push({ operationName: body.operationName, type: isMutation ? 'mutation' : 'query' });
          if (isMutation) return send(201, 'application/json', '{"data":{"addFav":{"ok":true}}}');
          const q = String(body.variables?.q ?? (body.variables as { term?: string } | undefined)?.term ?? '').toLowerCase();
          const limit = Number((body.variables as { limit?: number } | undefined)?.limit ?? 50);
          const hits = products.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, limit);
          return send(200, 'application/json', JSON.stringify({ data: { posts: hits.map((p) => ({ id: p.id, title: p.name, price: p.price })) } }));
        });
        return;
      }
      case '/nameless':
        return html(200, page(base, 'Product finder', `<h1>Product finder</h1><form id="nameless" action="/nameless"><input type="search" data-testid="nameless-input" placeholder="Find"><button type="submit">Go</button></form><script>document.getElementById('nameless').addEventListener('submit', function (e) { e.preventDefault(); location.href = '/find/' + encodeURIComponent(document.querySelector('[data-testid=nameless-input]').value); });</script>`));
      case '/swagger.yaml':
        return html(200, page(base, 'App', '<h1>Single page app shell</h1><p>This path answers HTML like every other path on a client-rendered site.</p>'));
      case '/api/products': {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const sort = url.searchParams.get('sort') ?? 'asc';
        let items = products.filter((p) => !q || p.name.toLowerCase().includes(q));
        if (sort === 'desc') items = [...items].reverse();
        return send(200, 'application/json', JSON.stringify(items));
      }
      case '/api/account':
        return send(401, 'application/json', '{"error":"login required"}');
      case '/keyed': {
        // A search whose results page calls a keyed JSON API from the browser with a publishable bearer key.
        const q = url.searchParams.get('q');
        if (q === null) {
          return html(200, page(base, 'Keyed search', `<h1>Keyed product search</h1><form id="keyed" action="/keyed" method="get"><input type="search" name="q" placeholder="Search the keyed catalog" data-testid="keyed-input"><button type="submit">Search</button></form>
<ul>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`).join('')}</ul>`));
        }
        const hits = products.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
        return html(200, page(base, `Keyed: ${q}`, `<h1>Keyed results for "${q}"</h1><ol>${hits.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`).join('')}</ol><p>API count: <span id="keyed-count">?</span></p>
<script>fetch('/api/keyed/products?q=' + encodeURIComponent(${JSON.stringify(q)}), { headers: { accept: 'application/json', authorization: ${JSON.stringify(KEYED_API_KEY)} } }).then(function (r) { return r.json(); }).then(function (items) { document.getElementById('keyed-count').textContent = String(items.length); }).catch(function () {});</script>`));
      }
      case '/api/keyed/products': {
        if (req.headers['authorization'] !== KEYED_API_KEY) {
          keyedCalls.push('unauthorized');
          return send(401, 'application/json', '{"error":"api key required"}');
        }
        keyedCalls.push('authorized');
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return send(200, 'application/json', JSON.stringify(products.filter((p) => !q || p.name.toLowerCase().includes(q))));
      }
      case '/events':
        // The listing sets the widget cookie; the browser then sends it with the three XHRs below.
        return html(200, page(base, 'Events', `<h1>Events</h1><ul class="grid">${events.map((e) => `<li><a href="/events/${e.id}">${e.title}</a></li>`).join('')}</ul><p>Upcoming fixture events, listed so a crawl that starts here finds a listing whose JSON feed the front end reads with a widget cookie attached.</p>
<script>fetch('/api/events', { headers: { accept: 'application/json' } }).catch(function () {});
fetch('/api/events/mine', { headers: { accept: 'application/json' } }).catch(function () {});
fetch('/api/events/digest', { headers: { accept: 'application/json', authorization: ${JSON.stringify(EVENTS_DIGEST_TOKEN)} } }).catch(function () {});</script>`), { 'set-cookie': `${EVENTS_WIDGET_COOKIE}=visitor-${Date.now()}; Path=/` });
      case '/api/events': {
        // Public: the same answer with or without the cookie. An optional limit lets a proposal give it an input.
        eventCalls.push(hasWidgetCookie() ? 'with-cookie' : 'without-cookie');
        const limit = Number(url.searchParams.get('limit') ?? events.length);
        return send(200, 'application/json', JSON.stringify(events.slice(0, limit > 0 ? limit : events.length)));
      }
      case '/api/events/mine':
        // Needs the cookie: a cookie-less replay gets 401 and the tool fails validation with PERMISSION_DENIED.
        return hasWidgetCookie() ? send(200, 'application/json', JSON.stringify(events.slice(0, 1))) : send(401, 'application/json', '{"error":"session required"}');
      case '/api/events/digest':
        // Needs an authorization header: never promotable without an operator-configured credential.
        return req.headers['authorization'] === EVENTS_DIGEST_TOKEN ? send(200, 'application/json', JSON.stringify(events)) : send(401, 'application/json', '{"error":"token required"}');
      case '/keyed-hop':
        // Redirects the keyed API call to the same server under another hostname: credential headers must not follow.
        res.writeHead(302, { location: `http://fixture.test:${(server.address() as AddressInfo).port}/api/keyed/products?q=product` });
        return res.end();
      case '/strict/':
        return html(200, page(base, 'Strict', '<h1>Strict trailing slash</h1><p>This section only answers with the trailing slash the site published, like static hosting does. Enough prose to look like a real page.</p>'));
      case '/strict':
        return html(404, page(base, 'Not found', '<h1>404</h1><p>No such page without the slash.</p>'));
      case '/latin1': {
        const body = Buffer.from('<!doctype html><html><head><meta charset="windows-1252"><title>Caf\u00e9 Men\u00fc</title></head><body><h1>Caf\u00e9 Men\u00fc</h1><p>Sp\u00e9cialit\u00e9s de la maison, servies toute la journ\u00e9e. Encore un peu de texte pour que la page ressemble \u00e0 une vraie page.</p></body></html>', 'latin1');
        return send(200, 'text/html; charset=windows-1252', body);
      }
      case '/find-page':
        return html(200, page(base, 'Find', '<h1>Find a product</h1><form id="find" method="post" action="/find"><input type="search" name="q" placeholder="Find products"><button type="submit">Find</button></form>'));
      case '/find': {
        if (req.method !== 'POST') return html(405, page(base, 'Method not allowed', '<h1>405</h1>'));
        return html(200, page(base, 'Found', `<h1>Found</h1><ol>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`).join('')}</ol>`));
      }
      case '/api/wishlist':
        return send(req.method === 'POST' ? 201 : 405, 'application/json', '{"ok":true}');
      case '/late': {
        // Results a client-rendered app shows only after its own calls return: placeholders first, n items later.
        const n = Math.max(0, Math.min(10, Number(url.searchParams.get('n') ?? '3') || 0));
        // flaky=1: the first load in a browsing context loses its own race and never renders; a reload does.
        const flaky = url.searchParams.get('flaky') === '1';
        return html(200, page(base, 'Late results', `<h1>Departures</h1><ul id="late"><li class="skeleton"></li><li class="skeleton"></li></ul><script>${flaky ? "if (!sessionStorage.getItem('loaded')) { sessionStorage.setItem('loaded', '1'); } else " : ''}setTimeout(function () { var ul = document.getElementById('late'); ul.innerHTML = ''; for (var i = 1; i <= ${n}; i++) { var li = document.createElement('li'); li.className = 'trip'; li.innerHTML = '<span class="time">' + (8 + i) + ':00</span> <span class="train">Train ' + i + '</span>'; ul.appendChild(li); } }, 2500);</script>`));
      }
      case '/framed':
        // A page whose booking form lives in an iframe, as on sites that embed their ticketing app.
        return html(200, page(base, 'Framed', '<h1>Book a trip</h1><iframe src="/app" width="600" height="400" title="Trip finder"></iframe>'));
      case '/app':
        // A single-page app, unlinked from the rest of the site: it logs in as a guest with a POST on load (like a
        // real booking app), renders nothing without that session, then offers a custom dropdown and a Find button
        // whose search is a POST as well. The Buy button is consequential and must never be clicked by WebMorph.
        return html(200, `<!doctype html><html lang="en"><head><title>Trip finder</title></head><body><div id="root"><p>Loading…</p></div>
<script>
(async function () {
  await fetch('/assets/i18n/en.json').catch(function () { return null; });
  var session = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'guest', password: 'guest-public', clientKey: 'web' }) }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  if (!session) return;
  var root = document.getElementById('root');
  root.innerHTML = '<h1>Trip finder</h1><div class="picker"><button id="cat-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="cat-list">Category: any</button><ul id="cat-list" role="listbox" hidden><li role="option" data-value="cheap">Cheap</li><li role="option" data-value="premium">Premium</li></ul></div><button id="find" type="button">Find trips</button> <button id="buy" type="button">Buy now</button><section id="results" aria-live="polite"></section>';
  var category = '';
  var btn = document.getElementById('cat-btn'), list = document.getElementById('cat-list');
  btn.addEventListener('click', function () { var open = btn.getAttribute('aria-expanded') === 'true'; btn.setAttribute('aria-expanded', String(!open)); list.hidden = open; });
  list.querySelectorAll('[role=option]').forEach(function (o) { o.addEventListener('click', function () { category = o.getAttribute('data-value'); btn.textContent = 'Category: ' + o.textContent; o.setAttribute('aria-selected', 'true'); list.hidden = true; btn.setAttribute('aria-expanded', 'false'); }); });
  document.getElementById('find').addEventListener('click', async function () {
    var items = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token }, body: JSON.stringify({ category: category }) }).then(function (r) { return r.json(); });
    document.getElementById('results').innerHTML = '<h2>' + items.length + ' trips</h2>' + items.map(function (t) { return '<article class="trip"><h3 class="name">' + t.name + '</h3><span class="price">' + t.price + ' SAR</span><span class="duration">' + t.duration + '</span><a class="more" href="/products/' + t.id + '">Details</a></article>'; }).join('');
  });
  document.getElementById('buy').addEventListener('click', function () { fetch('/api/buy', { method: 'POST', body: '{}' }); });
})();
</script></body></html>`);
      case '/assets/i18n/en.json':
        return send(200, 'application/json', '{"find":"Find trips","category":"Category"}');
      case '/api/session':
        if (req.method !== 'POST') return send(405, 'application/json', '{"error":"POST only"}');
        return send(200, 'application/json', '{"token":"guest-token"}');
      case '/api/search': {
        if (req.method !== 'POST') return send(405, 'application/json', '{"error":"POST only"}');
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        req.on('end', () => {
          let body: { category?: string } = {};
          try { body = JSON.parse(raw); } catch { /* ignore */ }
          const items = products.filter((p) => !body.category || (body.category === 'cheap' ? p.price <= 30 : p.price > 30)).map((p) => ({ id: p.id, name: p.name, price: p.price, duration: `${p.id}h ${(p.id * 7) % 60}m` }));
          send(200, 'application/json', JSON.stringify(items));
        });
        return;
      }
      case '/api/buy':
        buys.push(url.pathname);
        return send(201, 'application/json', '{"ok":true}');
      case '/flaky-redirect':
        flakyHits += 1;
        if (flakyHits % 2 === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(301, { location: '/about' });
        return res.end();
      case '/bomb.gz':
        return send(200, 'application/gzip', gzipSync(Buffer.alloc(8 * 1024 * 1024)));
      case '/r-doc':
        res.writeHead(302, { location: 'https://external.example/landing' });
        return res.end();
      case '/r-private':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/r-script':
        res.writeHead(302, { location: '/app.js' });
        return res.end();
      case '/redirect-in':
        res.writeHead(301, { location: '/about' });
        return res.end();
      case '/redirect-out':
        res.writeHead(302, { location: 'https://external.example/landing' });
        return res.end();
      case '/loop1':
        res.writeHead(302, { location: '/loop2' });
        return res.end();
      case '/loop2':
        res.writeHead(302, { location: '/loop1' });
        return res.end();
      case '/retry':
        retryHits += 1;
        if (retryHits % 2 === 1) return send(503, 'text/html', 'try again', { 'retry-after': '0' });
        return html(200, page(base, 'Flaky', '<h1>Flaky page</h1><p>This page fails every other request to exercise retries. It has enough text to be real content for the render-mode classifier.</p>'));
      case '/spa':
        return html(200, `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script><script>window.__APP__={}</script></body></html>`);
      case '/app.js':
        return send(200, 'application/javascript', `document.getElementById('root').innerHTML = '<h1>Client rendered app</h1><p>This content only exists after JavaScript runs, so the static crawler sees an empty shell while the browser sees a real page with navigation and text.</p><nav><a href="/about">About</a><a href="/products">Products</a></nav>';`);
      case '/analytics.js':
        return send(200, 'application/javascript', 'console.log("hi")');
      case '/image.png':
        return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case '/big':
        return send(200, 'text/html', `<html><body>${'x'.repeat(300_000)}</body></html>`);
      case '/blocked':
        return send(403, 'text/html', '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">Checking your browser before accessing the site.</div></body></html>', { server: 'cloudflare' });
      case '/private/secret':
        return html(200, page(base, 'Secret', '<h1>Should never be fetched</h1>'));
      default: {
        const find = url.pathname.match(/^\/find\/([^/]+)$/);
        if (find) {
          const term = decodeURIComponent(find[1]!).toLowerCase();
          const hits = products.filter((p) => p.name.toLowerCase().includes(term));
          // No <main>: extraction must fall back to the body and still ignore header, nav and footer links.
          return html(200, `<!doctype html><html lang="en"><head><title>Find: ${term}</title></head><body>${nav(base)}
<div class="results"><h1>Found ${hits.length}</h1><ul>${hits.map((p) => `<li><a href="/products/${p.id}">${p.name}</a></li>`).join('')}</ul></div>
<footer><a href="/products/999">Featured product</a></footer>
<script>fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'FindPosts', query: 'query FindPosts($term: String!, $limit: Int) { posts(term: $term, limit: $limit) { id title price } }', variables: { term: ${JSON.stringify(term)}, limit: 20 } }) }).catch(function () {});</script>
</body></html>`);
        }
        const apiProduct = url.pathname.match(/^\/api\/products\/(\d+)$/);
        if (apiProduct) {
          const p = products.find((x) => x.id === Number(apiProduct[1]));
          return p ? send(200, 'application/json', JSON.stringify(p)) : send(404, 'application/json', '{"error":"not found"}');
        }
        const product = url.pathname.match(/^\/products\/(\d+)$/);
        if (product) {
          const p = products.find((x) => x.id === Number(product[1]));
          if (p) {
            return html(200, page(base, p.name, `<article><h1>${p.name}</h1><p class="price">$${p.price}</p><p>A fine product with a detailed description that is long enough to look like real page content for the render mode classifier and other heuristics.</p><a href="/products/${(p.id % 6) + 1}">Next product</a></article>`, `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${p.name}"}</script>`));
          }
        }
        const doc = url.pathname.match(/^\/docs\/([a-z]+)$/);
        if (doc) {
          return html(200, page(base, `Docs: ${doc[1]}`, `<article class="doc"><h1>${doc[1]}</h1><p>Documentation for ${doc[1]}. This section explains how to use the fixture API in enough words to look like a documentation page to the extractor.</p><pre>code</pre></article><aside><a href="/docs/intro">Intro</a><a href="/docs/install">Install</a><a href="/docs/config">Config</a><a href="/docs/api">API</a></aside>`));
        }
        const car = url.pathname.match(/^\/cars\/([a-z0-9-]+)$/);
        if (car) {
          const c = cars.find((x) => x.slug === car[1]);
          if (!c) return html(404, page(base, 'Not found', '<h1>404</h1><p>No such car.</p>'));
          const other = cars.find((x) => x !== c)!;
          return html(200, page(base, c.title, `<article><h1>${c.title}</h1><p class="price">${c.price} SAR</p><p>A used ${c.make} ${c.model} with ${c.mileage} km on the clock, described at enough length to read as a real listing page. The page inlines its state as JSON the way a framework would.</p><a href="/cars/${other.slug}">Similar car</a></article>`, `<script>window.__PAGE_DATA__ = ${JSON.stringify(carPageData(c))};</script>`));
        }
        const event = url.pathname.match(/^\/events\/(\d+)$/);
        if (event) {
          const e = events.find((x) => x.id === Number(event[1]));
          if (!e) return html(404, page(base, 'Not found', '<h1>404</h1><p>No such event.</p>'));
          return html(200, page(base, e.title, `<article><h1>${e.title}</h1><p class="date">${e.date}</p><p>${e.title} takes place at ${e.venue}. A fixture event described at enough length to read as a real detail page for the template classifier and the entity heuristics.</p><a href="/events/${(e.id % events.length) + 1}">Next event</a></article>`));
        }
        const post = url.pathname.match(/^\/blog\/([a-z0-9-]+)$/);
        if (post) {
          const other = post[1] === 'hello-world-2026' ? 'second-post-2026' : 'hello-world-2026';
          return html(200, page(base, `Blog: ${post[1]}`, `<article><h1>${post[1]}</h1><p>A blog post with enough prose to count as content. It links to another post so the crawler discovers the second article and the slug pattern can be generalized.</p><a href="/blog/${other}">Next post</a></article>`));
        }
        return html(404, page(base, 'Not found', '<h1>404</h1><p>No such page.</p>'));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    posts,
    graphql,
    keyedCalls,
    buys,
    eventCalls,
    setMode: (m) => {
      mode = m;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
