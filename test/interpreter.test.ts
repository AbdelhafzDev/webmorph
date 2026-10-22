import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserRuntime } from '../src/browser/runtime.js';
import { executeTool } from '../src/tools/interpreter.js';
import { ScopePolicy } from '../src/net/scope.js';
import type { ToolSpec } from '../src/schemas/toolDefinition.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let runtime: BrowserRuntime;
let scope: ScopePolicy;

beforeAll(async () => {
  site = await startFixtureSite();
  scope = new ScopePolicy({ origin: site.baseUrl, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true, respectRobots: true, userAgent: 'test' });
  runtime = new BrowserRuntime({ scope, allowPrivate: true, userAgent: 'WebMorphTest/1' });
  await runtime.launch();
});
afterAll(async () => {
  await runtime.close();
  await site.close();
});

const opts = () => ({ scope, pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1000 });

function searchViaForm(): ToolSpec {
  const locator = { strategy: 'testid' as const, value: '[data-testid="search-input"]', unique: true, matches: 1, score: 100 };
  return {
    toolId: 'tool-form-search',
    name: 'search_products_form',
    version: '1.0.0',
    title: 'Search via form',
    description: 'Fills the header search form and submits it.',
    capabilityId: 'cap-x',
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    timeoutMs: 30_000,
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { results: { type: 'array' }, count: { type: 'integer' }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'] },
    preconditions: [],
    program: [
      { op: 'navigate', url: `${site.baseUrl}/` },
      { op: 'fill', locator, valueFrom: 'query' },
      { op: 'press', locator, key: 'Enter' },
      { op: 'wait', for: 'navigation', timeoutMs: 4000 },
      { op: 'assert', check: 'url-matches', value: '/search\\?q=' },
      { op: 'extract', extractor: { kind: 'link-list', into: 'results', scope: 'main', hrefPattern: '^/products/[^/?#]+/?$', maxItems: 50 } },
    ],
    expectedOutcome: 'results page',
    errorCases: [],
    examples: [{ inputs: { query: 'product' } }],
    evidence: [],
    status: 'draft',
  };
}

describe('tool interpreter', () => {
  it('executes a form-driven search program, waiting for the navigation the submit triggers', async () => {
    const result = await executeTool(runtime, searchViaForm(), { query: 'product' }, opts());
    expect(result.ok).toBe(true);
    expect(result.finalUrl).toContain('/search?q=product');
    const out = result.output as { count: number; results: Array<{ title: string }> };
    expect(out.count).toBe(6);
    expect(out.results[0]?.title).toMatch(/^Product/);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  }, 60_000);

  it('rejects invalid inputs before touching the browser', async () => {
    const before = site.requests.length;
    const result = await executeTool(runtime, searchViaForm(), { query: '' }, opts());
    expect(result).toMatchObject({ ok: false, errorCode: 'INPUT_INVALID' });
    expect(site.requests.length).toBe(before);
  });

  it('reports missing locators, out-of-scope navigation and 404s with typed codes', async () => {
    const tool = searchViaForm();
    const missing = { ...tool, program: [tool.program[0]!, { op: 'click' as const, locator: { strategy: 'css-id' as const, value: '#does-not-exist', unique: true, matches: 1, score: 90 } }] };
    expect(await executeTool(runtime, missing, { query: 'x' }, opts())).toMatchObject({ ok: false, errorCode: 'LOCATOR_MISSING' });

    const outside = { ...tool, program: [{ op: 'navigate' as const, url: 'https://external.example/' }] };
    const o = await executeTool(runtime, outside, { query: 'x' }, opts());
    expect(o).toMatchObject({ ok: false, errorCode: 'OUT_OF_SCOPE' });
    expect(site.requests.some((r) => r.includes('external'))).toBe(false);

    const gone = { ...tool, program: [{ op: 'navigate' as const, url: `${site.baseUrl}/no-such-page` }] };
    expect(await executeTool(runtime, gone, { query: 'x' }, opts())).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  }, 60_000);
});
