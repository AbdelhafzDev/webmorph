import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRuntime, gotoWithPolicy } from '../src/browser/runtime.js';
import { ScopePolicy } from '../src/net/scope.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

function scopeFor(hosts: string[], extra: { pathPatterns?: string[] } = {}) {
  return new ScopePolicy({ origin: site.baseUrl, allowedHosts: hosts, allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' }, extra);
}

describe('BrowserRuntime network policy', () => {
  it('dials through the policy proxy using the pinned resolver', async () => {
    const resolver = async (host: string) => (host === 'fixture.test' ? [{ address: '127.0.0.1', family: 4 }] : []);
    const runtime = new BrowserRuntime({ scope: scopeFor(['fixture.test']), allowPrivate: true, userAgent: 'test', resolver });
    await runtime.launch();
    try {
      const { context, close } = await runtime.newContext();
      const page = await context.newPage();
      const nav = await gotoWithPolicy(page, `http://fixture.test:${site.port}/about`, { timeout: 15_000 });
      expect(nav.response?.status()).toBe(200);
      expect(await page.title()).toBe('About');
      await close();
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('refuses a host whose checked address is private when private targets are not allowed', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const scope = new ScopePolicy({ origin: `http://fixture.test:${site.port}`, allowedHosts: ['fixture.test'], allowPrivateNetwork: false, respectRobots: true, userAgent: 'test' });
    const runtime = new BrowserRuntime({ scope, allowPrivate: false, userAgent: 'test', resolver });
    await runtime.launch();
    try {
      const { context, stats, close } = await runtime.newContext();
      const page = await context.newPage();
      await expect(gotoWithPolicy(page, `http://fixture.test:${site.port}/about`, { timeout: 10_000 })).rejects.toThrow();
      expect(stats.blockedRequests).toBeGreaterThanOrEqual(1);
      await close();
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('polices every redirect hop: out-of-scope and private targets are refused, in-scope ones are followed truthfully', async () => {
    const runtime = new BrowserRuntime({ scope: scopeFor(['127.0.0.1']), allowPrivate: true, userAgent: 'test' });
    await runtime.launch();
    try {
      const { context, stats, close } = await runtime.newContext();
      const page = await context.newPage();

      const ok = await gotoWithPolicy(page, `${site.baseUrl}/redirect-in`, { timeout: 15_000 });
      expect(ok.redirectChain).toEqual([`${site.baseUrl}/redirect-in`]);
      expect(ok.finalUrl).toBe(`${site.baseUrl}/about`);
      expect(await page.title()).toBe('About');

      const p2 = await context.newPage();
      await expect(gotoWithPolicy(p2, `${site.baseUrl}/r-doc`, { timeout: 10_000 })).rejects.toThrow();
      expect(stats.refusedRedirects.some((r) => r.to === 'https://external.example/landing' && r.reason === 'scope')).toBe(true);

      const p3 = await context.newPage();
      await expect(gotoWithPolicy(p3, `${site.baseUrl}/r-private`, { timeout: 10_000 })).rejects.toThrow();
      expect(stats.refusedRedirects.some((r) => r.to.startsWith('http://169.254.169.254/'))).toBe(true);
      expect(site.requests.some((r) => r.includes('external') || r.includes('169.254'))).toBe(false);

      const p4 = await context.newPage();
      await expect(gotoWithPolicy(p4, `${site.baseUrl}/loop1`, { timeout: 10_000 })).rejects.toThrow(/TOO_MANY_REDIRECTS/);
      await close();
    } finally {
      await runtime.close();
    }
  }, 90_000);

  it('follows subresource redirects within policy and refuses writes and prohibited paths', async () => {
    const runtime = new BrowserRuntime({ scope: scopeFor(['127.0.0.1'], { pathPatterns: ['^/privacy'] }), allowPrivate: true, userAgent: 'test' });
    await runtime.launch();
    try {
      const { context, stats, close, setAppRequests } = await runtime.newContext();
      const page = await context.newPage();
      await gotoWithPolicy(page, `${site.baseUrl}/`, { timeout: 15_000 });
      await page.setContent(`<html><body><script src="${site.baseUrl}/r-script"></script></body></html>`, { waitUntil: 'load' });
      expect(site.requests).toContain('/app.js');

      // D27: the page's own same-site POST is allowed while app requests are on (load, search-like actions) and recorded as such…
      const postsBefore = site.posts.length;
      await page.evaluate(() => fetch('/api/wishlist', { method: 'POST', body: '{}' }).catch(() => undefined));
      await page.waitForTimeout(300);
      expect(site.posts.length).toBe(postsBefore + 1);
      expect(stats.network.find((r) => r.url.endsWith('/api/wishlist'))).toMatchObject({ method: 'POST', allowedAs: 'app-request' });
      // …and refused once the actor turns them off, as every toggle-style probe does before acting (the R6 guarantee).
      setAppRequests(false);
      await page.evaluate(() => fetch('/api/wishlist', { method: 'POST', body: '{}' }).catch(() => undefined));
      await page.waitForTimeout(300);
      expect(site.posts.length).toBe(postsBefore + 1);
      expect(stats.blockedWrites).toBeGreaterThanOrEqual(1);

      const p5 = await context.newPage();
      await expect(gotoWithPolicy(p5, `${site.baseUrl}/privacy`, { timeout: 10_000 })).rejects.toThrow();
      expect(stats.blockedUrls).toContain(`${site.baseUrl}/privacy`);
      await close();
    } finally {
      await runtime.close();
    }
  }, 90_000);
});
