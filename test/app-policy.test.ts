import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRuntime, gotoWithPolicy } from '../src/browser/runtime.js';
import { settle } from '../src/browser/inspect.js';
import { executeTool } from '../src/tools/interpreter.js';
import { ScopePolicy } from '../src/net/scope.js';
import type { ToolSpec } from '../src/schemas/toolDefinition.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

const scopeFor = () => new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });

describe('D27: a page\'s own requests versus WebMorph\'s actions', () => {
  it('lets a single-page app log in as a guest with a POST on load and render, records it as an app request, and never promotes it', async () => {
    const runtime = new BrowserRuntime({ scope: scopeFor(), allowPrivate: true, userAgent: 'WebMorphTest/1' });
    await runtime.launch();
    try {
      const { context, stats, close } = await runtime.newContext({ pageUrl: `${site.baseUrl}/app` });
      const page = await context.newPage();
      await gotoWithPolicy(page, `${site.baseUrl}/app`, { timeout: 15_000 });
      await settle(page, 3000);
      expect(await page.locator('h1').textContent()).toBe('Trip finder');
      const session = stats.network.find((r) => r.url.endsWith('/api/session'))!;
      expect(session).toMatchObject({ method: 'POST', status: 200, allowedAs: 'app-request', requestBodyKeys: ['username', 'password', 'clientKey'] });
      expect(session.error).toBeUndefined();
      expect(stats.appRequests).toBe(1);
      expect(stats.blockedWrites).toBe(0);
      await close();
    } finally {
      await runtime.close();
    }
    expect(site.buys).toEqual([]);
  }, 60_000);

  it('keeps the app blank under strictMethods, and still refuses third-party POSTs and document-level POSTs', async () => {
    const runtime = new BrowserRuntime({ scope: scopeFor(), allowPrivate: true, userAgent: 'WebMorphTest/1', strictMethods: true });
    await runtime.launch();
    try {
      const { context, stats, close } = await runtime.newContext({ pageUrl: `${site.baseUrl}/app` });
      const page = await context.newPage();
      await gotoWithPolicy(page, `${site.baseUrl}/app`, { timeout: 15_000 });
      await settle(page, 2000);
      expect(await page.locator('h1').count()).toBe(0);
      expect(stats.network.find((r) => r.url.endsWith('/api/session'))).toMatchObject({ method: 'POST', error: 'refused: write' });
      expect(stats.blockedWrites).toBeGreaterThanOrEqual(1);
      await close();
      // Same policy, no strict flag: a POST to a host that is not the site's stays refused.
      const lax = new BrowserRuntime({ scope: scopeFor(), allowPrivate: true, userAgent: 'WebMorphTest/1' });
      expect(await lax.decide('https://www.google-analytics.com/j/collect', 'xhr', 'POST')).toBe('write');
      expect(await lax.decide(`${site.baseUrl}/api/session`, 'xhr', 'POST')).toBe('allow');
      expect(await lax.decide(`${site.baseUrl}/checkout`, 'document', 'POST')).toBe('write');
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('runs a program with a templated locator and an item-list extractor against the app, as a proposed workflow would', async () => {
    const runtime = new BrowserRuntime({ scope: scopeFor(), allowPrivate: true, userAgent: 'WebMorphTest/1' });
    await runtime.launch();
    try {
      const tool: ToolSpec = {
        toolId: 'tool-app',
        name: 'find_trips',
        version: '1.0.0',
        title: 'Find trips',
        description: 'Pick a category and list the trips.',
        capabilityId: 'cap-app',
        sideEffectClass: 'read',
        idempotent: true,
        authRequirement: 'none',
        transport: 'browser',
        timeoutMs: 30_000,
        inputSchema: { type: 'object', properties: { category: { type: 'string', enum: ['Cheap', 'Premium'] } }, required: ['category'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' }, url: { type: 'string' } }, required: ['name', 'price', 'url'], additionalProperties: false } }, count: { type: 'integer' }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'], additionalProperties: false },
        preconditions: [],
        program: [
          { op: 'navigate', url: `${site.baseUrl}/app` },
          { op: 'wait', for: 'dom-stable', timeoutMs: 3000 },
          { op: 'click', locator: { strategy: 'css-id', value: '#cat-btn', unique: true, matches: 1, score: 90 } },
          { op: 'click', locator: { strategy: 'role', value: 'option|{{category}}', unique: true, matches: 1, score: 80 } },
          { op: 'click', locator: { strategy: 'role', value: 'button|Find trips', unique: true, matches: 1, score: 80 } },
          { op: 'wait', for: 'dom-stable', timeoutMs: 3000 },
          { op: 'extract', extractor: { kind: 'item-list', into: 'results', item: '#results .trip', fields: { name: { selector: '.name' }, price: { selector: '.price' }, url: { selector: 'a.more', attr: 'href' } }, maxItems: 50 } },
        ],
        expectedOutcome: 'trips',
        errorCases: [],
        examples: [{ inputs: { category: 'Cheap' } }],
        evidence: [],
        status: 'draft',
      };
      const cheap = await executeTool(runtime, tool, { category: 'Cheap' }, { scope: scopeFor(), pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(cheap.ok, cheap.errorMessage).toBe(true);
      const out = cheap.output as { results: Array<{ name: string; price: string; url: string }>; count: number };
      expect(out.count).toBe(3);
      expect(out.results[0]).toEqual({ name: 'Product 1', price: '10 SAR', url: `${site.baseUrl}/products/1` });
      const premium = await executeTool(runtime, tool, { category: 'Premium' }, { scope: scopeFor(), pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect((premium.output as { count: number }).count).toBe(3);
      const missing = await executeTool(runtime, { ...tool, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, {}, { scope: scopeFor(), pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1500 });
      expect(missing).toMatchObject({ ok: false, errorCode: 'INPUT_INVALID' });
    } finally {
      await runtime.close();
    }
    expect(site.buys).toEqual([]);
    expect(site.posts.filter((p) => p === '/api/search').length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
