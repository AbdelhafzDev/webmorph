import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { discover, ToolExecutor, ToolRegistry, createMcpServer } from '../src/index.js';
import { FileArtifactStore } from '../src/core/store.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
let store: FileArtifactStore;
let siteId: string;
let executor: ToolExecutor;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-adapter-'));
  const result = await discover({
    startUrl: `${site.baseUrl}/`,
    outDir,
    allowPrivate: true,
    model: { enabled: false },
    budget: { maxPages: 30, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 10, maxProbesPerPage: 4, maxProbesTotal: 8, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
    sleep: async () => {},
  });
  store = result.store;
  siteId = result.siteId;
  executor = new ToolExecutor({ store, siteId, maxConcurrency: 2, degradeAfter: 2 });
}, 240_000);
afterAll(async () => {
  await executor.close();
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('phase 4: registry, executor and MCP adapter', () => {
  it('publishes validated tools and executes them with policy and statistics', async () => {
    const registry = new ToolRegistry(store, siteId);
    const published = await registry.publish({});
    expect(published.published).toEqual(expect.arrayContaining(['search_products', 'list_products', 'get_product']));

    const unpublished = await executor.call('nope', {});
    expect(unpublished).toMatchObject({ ok: false, errorCode: 'TOOL_UNAVAILABLE' });

    // search_products is the site's JSON API (API first); search_products_browser drives the page.
    const search = await executor.call('search_products', { query: 'product' });
    expect(search.ok).toBe(true);
    expect((search.output as { data: unknown[] }).data).toHaveLength(6);
    expect(search.status).toBe('published');
    const browserSearch = await executor.call('search_products_browser', { query: 'product' });
    expect(browserSearch.ok).toBe(true);
    expect((browserSearch.output as { count: number }).count).toBe(6);

    const bad = await executor.call('search_products', { query: '' });
    expect(bad).toMatchObject({ ok: false, errorCode: 'INPUT_INVALID' });

    const detail = await executor.call('get_product', { id: '3' });
    expect(detail.ok).toBe(true);
    expect((detail.output as { data: { name: string } }).data.name).toBe('Product 3');
    const browserDetail = await executor.call('get_product_browser', { id: '3' });
    expect((browserDetail.output as { title: string }).title).toBe('Product 3');

    const entry = (await registry.get('search_products'))!;
    expect(entry.calls).toMatchObject({ total: 2, ok: 1, failed: 1, consecutiveFailures: 0 });

    await registry.setStatus('get_product', 'disabled', 'test');
    expect(await executor.call('get_product', { id: '3' })).toMatchObject({ ok: false, errorCode: 'TOOL_UNAVAILABLE', status: 'disabled' });
    await registry.setStatus('get_product', 'published', 'test');
  }, 120_000);

  it('degrades a tool after the site changes and restores it on revalidation', async () => {
    // The HTML search page moves; the JSON API behind search_products is unaffected, so the browser fallback is the tool that degrades.
    site.setMode('search-moved');
    try {
      const first = await executor.call('search_products_browser', { query: 'product' });
      expect(first).toMatchObject({ ok: false, errorCode: 'NOT_FOUND', status: 'published' });
      const second = await executor.call('search_products_browser', { query: 'product' });
      expect(second).toMatchObject({ ok: false, errorCode: 'NOT_FOUND', status: 'degraded' });
      const third = await executor.call('search_products_browser', { query: 'product' });
      expect(third).toMatchObject({ ok: false, errorCode: 'TOOL_UNAVAILABLE', status: 'degraded' });
      expect(third.errorMessage).toContain('revalidate');
      const api = await executor.call('search_products', { query: 'product' });
      expect(api.ok).toBe(true);
    } finally {
      site.setMode('normal');
    }
    const results = await executor.revalidate(['search_products_browser']);
    expect(results).toEqual([{ name: 'search_products_browser', verdict: 'validated', status: 'published' }]);
    const again = await executor.call('search_products_browser', { query: 'product' });
    expect(again.ok).toBe(true);
  }, 120_000);

  it('serves the published tools over MCP with typed schemas and structured results', async () => {
    const server = createMcpServer({ executor, siteId, origin: site.baseUrl });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // get_post (structured data) failed validation on the fixture's blog pages, so only its browser fallback is published.
      expect(names).toEqual(expect.arrayContaining(['get_post_browser', 'get_product', 'list_products', 'search_products']));
      expect(names).not.toContain('get_post');
      const search = tools.find((t) => t.name === 'search_products')!;
      expect(search.inputSchema).toMatchObject({ type: 'object', required: ['query'] });
      expect(search.outputSchema).toMatchObject({ type: 'object' });
      expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

      // API tools are listed first, browser fallbacks after them.
      const transports = tools.map((t) => (t.name.endsWith('_browser') ? 'browser' : 'http'));
      expect(transports.indexOf('browser')).toBeGreaterThan(transports.lastIndexOf('http'));

      const result = await client.callTool({ name: 'list_products_browser', arguments: { sort: 'desc' } });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { count: number; results: Array<{ title: string }>; pageUrl: string };
      expect(structured.count).toBe(3);
      expect(structured.pageUrl).toContain('sort=desc');
      expect(structured.results[0]?.title).toBe('Product 6');
      const api = await client.callTool({ name: 'list_products', arguments: { sort: 'desc' } });
      expect(api.isError).toBeFalsy();
      expect((api.structuredContent as { data: Array<{ name: string }> }).data[0]?.name).toBe('Product 6');

      const failure = await client.callTool({ name: 'get_product', arguments: { id: 'does-not-exist' } });
      expect(failure.isError).toBe(true);
      const text = (failure.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(JSON.parse(text)).toMatchObject({ code: 'NOT_FOUND' });

      const unknown = await client.callTool({ name: 'delete_everything', arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(site.posts).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});
