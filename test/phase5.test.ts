import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, stage0Scope, stage1Docs, ToolExecutor, ToolRegistry } from '../src/index.js';
import { ApiCandidates, DocumentationIndex, NetworkEvidence, ToolDefinition, ValidationReport, WebsiteModel } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-phase5-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('phase 5: documentation discovery', () => {
  it('finds llms.txt and the OpenAPI description, classifies operations, and records misses', async () => {
    const result = await discover({ stages: [stage0Scope, stage1Docs], startUrl: `${site.baseUrl}/`, outDir, allowPrivate: true, budget: { minDelayMs: 0 }, sleep: async () => {} });
    const docs = (await result.store.readArtifact(result.siteId, result.jobId, 'DocumentationIndex', DocumentationIndex)).data;
    const kinds = Object.fromEntries(docs.sources.map((s) => [new URL(s.url).pathname, s.kind]));
    expect(kinds['/llms.txt']).toBe('llms-txt');
    expect(kinds['/openapi.json']).toBe('openapi');
    expect(kinds['/swagger.json']).toBe('missing');
    expect(kinds['/docs/intro']).toBe('html');
    expect(docs.llms?.title).toBe('Fixture Shop');
    expect(docs.llms?.sections[0]?.links.map((l) => new URL(l.url).pathname)).toEqual(['/docs/intro', '/openapi.json']);
    expect(docs.apis).toHaveLength(1);
    const api = docs.apis[0]!;
    expect(api.title).toBe('Fixture Shop API');
    expect(api.servers).toEqual([`${site.baseUrl}/api`]);
    expect(api.operations.map((o) => o.operationId).sort()).toEqual(['addToWishlist', 'getAccount', 'getProduct', 'listProducts']);
    expect(api.operations.find((o) => o.operationId === 'listProducts')).toMatchObject({ authRequired: false, sideEffectClass: 'read', responseIsArray: true, responseKeys: ['id', 'name', 'price'] });
    expect(api.operations.find((o) => o.operationId === 'addToWishlist')).toMatchObject({ authRequired: true, sideEffectClass: 'write', securitySchemes: ['cookieAuth'] });
    expect(docs.stats).toMatchObject({ operations: 4, readOperationsWithoutAuth: 2 });
    expect(docs.sources.find((s) => s.url.endsWith('/swagger.yaml'))).toMatchObject({ kind: 'missing', error: expect.stringContaining('soft 404') });
    expect(docs.stats.requests).toBeLessThanOrEqual(25);
    expect(docs.notes[0]).toContain('site');
  }, 60_000);
});

describe('phase 5: search without a named field', () => {
  it('derives a path-based search capability from where the probe landed', async () => {
    const result = await discover({
      startUrl: `${site.baseUrl}/nameless`,
      outDir,
      allowPrivate: true,
      model: { enabled: false },
      budget: { maxPages: 4, maxDepth: 0, minDelayMs: 0, maxPagesToInspect: 1, maxProbesPerPage: 3, maxProbesTotal: 3, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
      sleep: async () => {},
    });
    const model = (await result.store.readArtifact(result.siteId, result.jobId, 'WebsiteModel', WebsiteModel)).data;
    const search = model.capabilities.find((c) => c.kind === 'search' && c.mechanics.pathTemplate)!;
    expect(search).toBeDefined();
    expect(search.mechanics).toMatchObject({ pathTemplate: '/find/{{query}}', navigateUrl: site.baseUrl, directUrlObserved: true, resultLinkPattern: '^/products/\\d+/?$' });
    expect(search.inputs[0]).toMatchObject({ name: 'query', source: 'path-segment', example: 'product' });
    // The GraphQL query that carried the typed value during the probe becomes the API behind the search.
    expect(search.mechanics.api).toMatchObject({ source: 'observed', method: 'POST', urlTemplate: `${site.baseUrl}/graphql`, credentialed: false, authRequired: false });
    expect(search.mechanics.api?.graphql).toMatchObject({ operationName: 'FindPosts', variables: { term: '{{query}}', limit: 20 } });
    expect(search.inputs.map((i) => i.name)).toEqual(['query']); // GraphQL-only variables belong to the API variant
    expect(search.mechanics.api?.graphql?.optionalInputs?.map((i) => i.name)).toEqual(['limit']);
    expect(model.capabilities.filter((c) => c.kind === 'search')).toHaveLength(2); // header search and the nameless one, each once
    const report = (await result.store.readArtifact(result.siteId, result.jobId, 'ValidationReport', ValidationReport)).data;
    // API first: the GraphQL route carries the capability's name, the browser route is `_browser`.
    const v = report.tools.find((t) => t.name === `${search.name}_browser`)!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { count: number }).count).toBe(6); // the footer's /products/999 link is site chrome, not a result
    const api = report.tools.find((t) => t.name === search.name)!;
    expect(api.verdict, api.failureReasons.join('; ')).toBe('validated');
    const payload = api.runs[0]!.output as { data: { data: { posts: Array<{ title: string }> } }; status: number };
    expect(payload.status).toBe(200);
    expect(payload.data.data.posts).toHaveLength(6);
    expect(site.graphql.filter((g) => g.type === 'mutation')).toEqual([]);
    // Declared GraphQL variables become optional inputs of the API tool.
    const tools = (await result.store.readArtifact(result.siteId, result.jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const apiTool = tools.find((t) => t.name === search.name)!;
    expect(apiTool.inputSchema).toMatchObject({ properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] });
    const registry = new ToolRegistry(result.store, result.siteId);
    await registry.publish({ names: [apiTool.name] });
    const executor = new ToolExecutor({ store: result.store, siteId: result.siteId });
    try {
      const limited = await executor.call(apiTool.name, { query: 'product', limit: 2 });
      expect(limited.ok).toBe(true);
      expect((limited.output as { data: { data: { posts: unknown[] } } }).data.data.posts).toHaveLength(2);
    } finally {
      await executor.close();
    }
  }, 120_000);
});

describe('phase 5: network evidence and API-backed tools', () => {
  it('captures redacted API traffic, ties it to capabilities, and generates validated HTTP tools', async () => {
    const result = await discover({
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      model: { enabled: false },
      budget: { maxPages: 30, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 10, maxProbesPerPage: 4, maxProbesTotal: 8, settleTimeoutMs: 1200, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
      sleep: async () => {},
    });
    const { store, siteId, jobId, job } = result;
    expect(job.status).toBe('completed');
    expect(Object.fromEntries(job.stages.map((s) => [s.id, s.status]))).toMatchObject({ 'stage1-docs': 'completed', 'stage7-network': 'completed' });

    const network = (await store.readArtifact(siteId, jobId, 'NetworkEvidence', NetworkEvidence)).data;
    expect(network.stats.total).toBeGreaterThan(0);
    const apiCall = network.records.find((r) => r.url.includes('/api/products?q=product'))!;
    expect(apiCall).toMatchObject({ method: 'GET', status: 200, credentialed: false, inScope: true, responseShape: { kind: 'array', itemKeys: ['id', 'name', 'price'] } });
    expect(network.records.every((r) => !/cookie|authorization/i.test(JSON.stringify(r)))).toBe(true);
    expect(network.redaction.bodiesStored).toBe(false);
    const log = await readFile(join(result.jobDir, network.evidenceLog), 'utf8');
    expect(log.trim().split('\n').length).toBe(network.stats.total);

    // GraphQL: queries pass the method policy and are captured with their operation; mutations stay refused.
    const gqlQuery = network.records.find((r) => r.url.endsWith('/graphql') && r.graphql?.[0]?.operationName === 'SearchPosts')!;
    expect(gqlQuery).toMatchObject({ method: 'POST', status: 200, credentialed: false, graphql: [expect.objectContaining({ operationType: 'query', variableNames: ['q'] })] });
    expect(gqlQuery.error).toBeUndefined();
    const gqlMutation = network.records.find((r) => r.graphql?.[0]?.operationName === 'AddFav')!;
    expect(gqlMutation).toMatchObject({ error: 'refused: write', graphql: [expect.objectContaining({ operationType: 'mutation' })] });
    expect(site.graphql.filter((g) => g.type === 'mutation')).toEqual([]);
    expect(site.graphql.some((g) => g.operationName === 'SearchPosts')).toBe(true);
    const candidates = (await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates)).data;
    const gqlCandidate = candidates.candidates.find((c) => c.graphql?.operationName === 'SearchPosts')!;
    expect(gqlCandidate).toMatchObject({ method: 'POST', sideEffectHint: 'read', credentialed: false });
    expect(gqlCandidate.graphql?.query).toContain('posts(q: $q)');
    expect(candidates.candidates.some((c) => c.graphql?.operationName === 'AddFav')).toBe(false);
    const search = candidates.candidates.find((c) => c.pathPattern === '/api/products' && c.queryParams.includes('q'))!;
    expect(search).toMatchObject({ method: 'GET', documentedOperationId: 'listProducts', sideEffectHint: 'read', credentialed: false, inScope: true });
    expect(search.confidence).toBeGreaterThanOrEqual(0.8);
    expect(candidates.stats.documented).toBeGreaterThanOrEqual(1);

    const model = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    expect(model.apis?.[0]).toMatchObject({ operations: 4, readOperationsWithoutAuth: 2 });
    const searchCap = model.capabilities.find((c) => c.name === 'search_products')!;
    expect(searchCap.mechanics.api).toMatchObject({ source: 'both', method: 'GET', urlTemplate: `${site.baseUrl}/api/products`, queryParams: { q: 'query' }, documentedOperationId: 'listProducts', authRequired: false, credentialed: false });
    const detailCap = model.capabilities.find((c) => c.name === 'get_product')!;
    expect(detailCap.mechanics.api).toMatchObject({ source: 'documented', urlTemplate: `${site.baseUrl}/api/products/{{id}}`, documentedOperationId: 'getProduct' });
    const listCap = model.capabilities.find((c) => c.name === 'list_products')!;
    expect(listCap.mechanics.api).toMatchObject({ source: 'documented', documentedOperationId: 'listProducts', queryParams: { sort: 'sort' } });
    expect(model.facts.some((f) => f.statement.includes('documents 4 operation'))).toBe(true);

    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const names = tools.map((t) => t.name);
    // API first: the JSON API carries each capability's name; the browser route is the `_browser` fallback.
    expect(names).toEqual(expect.arrayContaining(['search_products', 'search_products_browser', 'get_product', 'get_product_browser', 'list_products', 'list_products_browser']));
    expect(names.some((n) => /account|wishlist/.test(n))).toBe(false);
    const apiTool = tools.find((t) => t.name === 'search_products')!;
    expect(apiTool).toMatchObject({ transport: 'http', sideEffectClass: 'read', authRequirement: 'none' });
    expect(apiTool.program.map((s) => s.op)).toEqual(['http', 'extract']);
    expect(apiTool.inputSchema).toMatchObject({ required: ['query'] });
    expect(apiTool.evidence.some((e) => e.artifactType === 'DocumentationIndex')).toBe(true);
    const browserSearch = tools.find((t) => t.name === 'search_products_browser')!;
    expect(browserSearch.title).toContain('(browser)');
    expect(browserSearch.transport).not.toBe('http');

    // Detail pages publish JSON-LD, so a structured-data route exists beside the browser one.
    const pageData = tools.find((t) => t.name === 'get_post')!;
    expect(pageData).toMatchObject({ transport: 'http' });
    expect(pageData.program.map((s) => s.op)).toEqual(['http', 'extract']);
    expect((pageData.program[1] as { extractor: { kind: string } }).extractor.kind).toBe('html-data');
    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    for (const name of ['search_products', 'get_product', 'list_products']) {
      const v = report.tools.find((t) => t.name === name)!;
      expect(v.verdict, `${name}: ${v.failureReasons.join('; ')}`).toBe('validated');
    }
    const postData = report.tools.find((t) => t.name === 'get_post')!;
    expect(postData.verdict).toBe('failed'); // blog posts carry no JSON-LD or embedded JSON
    expect(postData.failureReasons[0]).toContain('no structured data');
    const searchRun = report.tools.find((t) => t.name === 'search_products')!.runs[0]!;
    expect((searchRun.output as { data: unknown[]; status: number }).data).toHaveLength(6);
    expect(searchRun.durationMs).toBeLessThan(3000);

    // The executor serves HTTP tools without launching a browser.
    const registry = new ToolRegistry(store, siteId);
    await registry.publish({ names: ['search_products', 'get_product'] });
    const executor = new ToolExecutor({ store, siteId });
    try {
      const call = await executor.call('search_products', { query: 'product 2' });
      expect(call.ok).toBe(true);
      expect((call.output as { data: Array<{ name: string }> }).data).toEqual([{ id: 2, name: 'Product 2', price: 20 }]);
      const missing = await executor.call('get_product', { id: '999' });
      expect(missing).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    } finally {
      await executor.close();
    }
    expect(site.posts).toEqual([]);
  }, 240_000);
});
