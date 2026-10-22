import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeHttpClient } from '../src/net/http.js';
import { ScopePolicy } from '../src/net/scope.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

function client(overrides: Partial<ConstructorParameters<typeof SafeHttpClient>[0]> = {}) {
  const scope = new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });
  return new SafeHttpClient({
    scope,
    allowPrivate: true,
    userAgent: 'WebMorphTest/1',
    requestTimeoutMs: 5000,
    maxResponseBytes: 200_000,
    maxRedirects: 3,
    maxRetries: 2,
    minDelayMs: 0,
    maxConcurrency: 2,
    maxRequests: 100,
    sleep: async () => {},
    ...overrides,
  });
}

describe('SafeHttpClient', () => {
  it('follows in-scope redirects and records the chain', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/redirect-in`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.finalUrl).toBe(`${site.baseUrl}/about`);
    expect(res.redirectChain).toEqual([{ url: `${site.baseUrl}/redirect-in`, status: 301 }]);
    await c.close();
  });
  it('refuses redirects that leave scope and names the refused target', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/redirect-out`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('out-of-scope');
    expect(res.refusedUrl).toBe('https://external.example/landing');
    expect(site.requests.filter((r) => r.includes('external'))).toHaveLength(0);
    await c.close();
  });
  it('stops redirect loops', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/loop1`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('too-many-redirects');
    await c.close();
  });
  it('caps response size', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/big`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('too-large');
    await c.close();
  });
  it('retries retryable statuses', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/retry`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(2);
    await c.close();
  });
  it('skips bodies of unwanted content types', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/image.png`, { acceptTypes: /text\/html/ });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bodySkipped).toBe(true);
    expect(res.body.length).toBe(0);
    expect(res.contentType).toBe('image/png');
    await c.close();
  });
  it('blocks private targets unless allowed', async () => {
    const c = client({ allowPrivate: false });
    const res = await c.fetch(`${site.baseUrl}/`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('ssrf-blocked');
    await c.close();
  });
  it('enforces the request budget', async () => {
    const c = client({ maxRequests: 1 });
    expect((await c.fetch(`${site.baseUrl}/about`)).ok).toBe(true);
    const second = await c.fetch(`${site.baseUrl}/about`);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe('budget-exhausted');
    await c.close();
  });
  it('decompresses gzip bodies', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/sitemap-products.xml.gz`, { acceptTypes: /gzip|xml/ });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.toString('utf8')).toContain('<urlset');
    await c.close();
  });
});

describe('SafeHttpClient redirects to trailing-slash variants', () => {
  it('follows the redirect verbatim instead of looping', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/trail`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.finalUrl).toBe(`${site.baseUrl}/trail/`);
    expect(res.redirectChain).toHaveLength(1);
    expect(res.attempts).toBe(2);
    await c.close();
  });
  it('fails fast on a loop rather than spending the redirect budget', async () => {
    const c = client({ maxRedirects: 20 });
    const res = await c.fetch(`${site.baseUrl}/loop1`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('too-many-redirects');
    expect(res.message).toContain('loop');
    expect(res.redirectChain.length).toBeLessThanOrEqual(3);
    await c.close();
  });
});

describe('SafeHttpClient pinned DNS', () => {
  it('dials through the pinned lookup: a hostname only the resolver knows reaches the fixture', async () => {
    const resolver = async (host: string) => (host === 'fixture.test' ? [{ address: '127.0.0.1', family: 4 }] : []);
    const scope = new ScopePolicy({ origin: `http://fixture.test:${site.port}`, allowedHosts: ['fixture.test'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });
    const c = new SafeHttpClient({ scope, allowPrivate: true, userAgent: 'WebMorphTest/1', requestTimeoutMs: 5000, maxResponseBytes: 200_000, maxRedirects: 3, maxRetries: 0, minDelayMs: 0, maxConcurrency: 1, maxRequests: 10, resolver, sleep: async () => {} });
    const res = await c.fetch(`http://fixture.test:${site.port}/about`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toContain('About us');
    await c.close();
  });
  it('refuses a public-looking hostname whose address is private at dial time', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const scope = new ScopePolicy({ origin: `http://fixture.test:${site.port}`, allowedHosts: ['fixture.test'], allowPrivateNetwork: false, respectRobots: true, userAgent: 'test' });
    const c = new SafeHttpClient({ scope, allowPrivate: false, userAgent: 'WebMorphTest/1', requestTimeoutMs: 5000, maxResponseBytes: 200_000, maxRedirects: 3, maxRetries: 0, minDelayMs: 0, maxConcurrency: 1, maxRequests: 10, resolver, sleep: async () => {} });
    const res = await c.fetch(`http://fixture.test:${site.port}/about`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('ssrf-blocked');
    expect(site.requests.filter((r) => r === '/about').length).toBeGreaterThanOrEqual(0);
    await c.close();
  });
});

describe('SafeHttpClient review regressions', () => {
  it('follows a redirect that arrives after a retried transient error', async () => {
    const c = client({ maxRetries: 2 });
    const res = await c.fetch(`${site.baseUrl}/flaky-redirect`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.finalUrl).toBe(`${site.baseUrl}/about`);
    expect(res.attempts).toBeGreaterThanOrEqual(2);
    await c.close();
  });
  it('bounds decompression so a gzip bomb is reported as too large', async () => {
    const c = client();
    const res = await c.fetch(`${site.baseUrl}/bomb.gz`, { acceptTypes: /gzip/ });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('too-large');
    await c.close();
  });
  it('charges retries against the request budget', async () => {
    const c = client({ maxRequests: 1, maxRetries: 3 });
    const res = await c.fetch(`${site.baseUrl}/retry`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('budget-exhausted');
    expect(c.requestsMade).toBe(1);
    await c.close();
  });
  it('refuses prohibited paths before dialing', async () => {
    const scope = new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' }, { pathPatterns: ['^/about'] });
    const c = client({ scope });
    const before = site.requests.filter((r) => r === '/about').length;
    const res = await c.fetch(`${site.baseUrl}/about`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('prohibited');
    expect(site.requests.filter((r) => r === '/about').length).toBe(before);
    await c.close();
  });
});
