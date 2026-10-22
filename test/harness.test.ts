import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover } from '../src/index.js';
import { FakeChatClient, type ChatTurnRequest, type ScriptedTurn } from '../src/model/llm.js';
import { elideOldResults, harnessTools, midpointNudge, tokensSpent } from '../src/model/agent.js';
import { ToolDefinition, ValidationReport, WebsiteModel } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-harness-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

const budget = { maxPages: 30, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 6, maxProbesPerPage: 4, maxProbesTotal: 6, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1, maxAgentInspections: 0 };

/** The evidence payload the harness sent on turn 0, parsed. */
function payloadOf(req: ChatTurnRequest): { capabilities: Array<{ capabilityId: string; name: string }>; apiCandidates: Array<{ candidateId: string; urlTemplate: string; queryParams: string[] }>; facts: Array<{ factId: string }> } {
  const first = req.messages[0]!;
  const text = typeof first.content === 'string' ? first.content : (first.content[0] as { text: string }).text;
  return JSON.parse(text.slice(text.indexOf('{'))) as ReturnType<typeof payloadOf>;
}

describe('harness tools', () => {
  it('declares strict tools and offers inspect_page only with a browser', () => {
    const withBrowser = harnessTools(true);
    const without = harnessTools(false);
    expect(withBrowser.map((t) => t.name)).toContain('inspect_page');
    expect(without.map((t) => t.name)).not.toContain('inspect_page');
    for (const t of without) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required).toEqual(Object.keys(t.input_schema.properties as object));
    }
  });
});

describe('harness token economy', () => {
  it('words the midpoint note as a push to propose', () => {
    expect(midpointNudge(12)).toMatch(/half the turn budget is spent and no capability has been kept yet \(12 turns remain\)\. Stop exploring/);
  });

  it('counts cache reads at a tenth of their tokens', () => {
    expect(tokensSpent({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50_000 })).toBe(6200);
  });

  it('cuts long results older than the last rounds, never the evidence payload, without mutating sent messages', () => {
    const long = 'x'.repeat(5000);
    const round = (id: string) => ({ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: id, content: long }] });
    const reply = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] };
    const first = { role: 'user' as const, content: [{ type: 'text' as const, text: long }] };
    const messages = [first, reply, round('a'), reply, round('b'), reply, round('c')];
    const before = messages[2];
    elideOldResults(messages, 2);
    const text = (i: number) => ((messages[i]!.content as Array<{ content?: string; text?: string }>)[0]!.content ?? (messages[i]!.content as Array<{ text: string }>)[0]!.text);
    expect(text(0)).toHaveLength(5000);
    expect(text(2)).toMatch(/^x{400}…\[older result elided/);
    expect(text(4)).toHaveLength(5000);
    expect(text(6)).toHaveLength(5000);
    expect((before!.content[0] as { content: string }).content).toHaveLength(5000);
    elideOldResults(messages, 2);
    expect(text(2)).toMatch(/elided/);
    expect(text(2).length).toBeLessThan(600);
  });
});

describe('stage 8 model harness (D26)', () => {
  it('lets the model read evidence within policy, keeps only proposals that validate by replay, and records everything', async () => {
    const base = site.baseUrl;
    let payload: ReturnType<typeof payloadOf> | undefined;
    const script = (turn: number, req: ChatTurnRequest): ScriptedTurn => {
      payload ??= payloadOf(req);
      const search = payload.capabilities.find((c) => c.name === 'search_products')!;
      const listCandidate = payload.apiCandidates.find((c) => c.urlTemplate === `${base}/api/products` && c.queryParams.includes('q'));
      const evidence = [{ artifactType: 'DocumentationIndex', refId: 'listProducts' }, { artifactType: 'PageInventory', refId: `${base}/products` }, ...(listCandidate ? [{ artifactType: 'ApiCandidates', refId: listCandidate.candidateId }] : [])];
      const proposal = (name: string, extra: Record<string, unknown>) => ({
        kind: 'list',
        name,
        title: 'Products by price',
        description: 'List the catalog sorted by price.',
        entity: 'product',
        inputs: [{ name: 'sort', type: 'string', required: true, description: 'asc or desc', example: 'desc', source: 'url-param', param: 'sort' }],
        mechanics: { navigateUrl: null, pathTemplate: null, queryParams: [], resultLinkPattern: null, formId: null, fieldElementId: null, api: { method: 'GET', urlTemplate: `${base}/api/products`, queryParams: [{ param: 'sort', input: 'sort' }], graphql: null } },
        evidence,
        expectedOutcome: 'A JSON array of products.',
        confidence: 0.9,
        ...extra,
      });
      switch (turn) {
        case 0:
          return [
            { tool: 'get_evidence', input: { kind: 'page', id: `${base}/products` } },
            { tool: 'get_evidence', input: { kind: 'docs', id: 'listProducts' } },
            { tool: 'fetch_json', input: { url: `${base}/api/products?sort=desc` } },
            { tool: 'fetch_page', input: { url: 'https://external.example/' } },
            { tool: 'fetch_json', input: { url: 'http://169.254.169.254/latest/meta-data/' } },
          ];
        case 1:
          return [
            // A write disguised as an API: refused before anything is dialed.
            { tool: 'propose_capability', input: proposal('add_to_wishlist', { mechanics: { navigateUrl: null, pathTemplate: null, queryParams: [], resultLinkPattern: null, formId: null, fieldElementId: null, api: { method: 'POST', urlTemplate: `${base}/api/wishlist`, queryParams: [], graphql: null } } }) },
            // Fabricated evidence: refused.
            { tool: 'propose_capability', input: proposal('list_products_fake', { evidence: [{ artifactType: 'ApiCandidates', refId: 'api-does-not-exist' }] }) },
            // A page that does not exist: generated, replayed, and fails validation.
            { tool: 'propose_capability', input: proposal('list_nowhere', { mechanics: { navigateUrl: null, pathTemplate: null, queryParams: [], resultLinkPattern: null, formId: null, fieldElementId: null, api: { method: 'GET', urlTemplate: `${base}/api/nowhere`, queryParams: [{ param: 'sort', input: 'sort' }], graphql: null } } }) },
          ];
        case 2:
          return [
            { tool: 'propose_capability', input: proposal('list_products_by_price', {}) },
            { tool: 'revise_capability', input: { capabilityId: search.capabilityId, name: 'find_products', title: 'Find products', description: 'Search the catalog by keyword.', entity: null, drop: false, reason: null } },
            { tool: 'propose_entity', input: { name: 'product', plural: 'products', description: 'An item in the fixture catalog.', detailPageTypeId: null, listPageTypeIds: [], confidence: 0.9 } },
            { tool: 'set_site_summary', input: { purpose: 'A small demo shop with six products.', confidence: 0.9, hypotheses: [{ statement: 'Search matches product names.', confidence: 0.8, basedOn: [payload.facts[0]!.factId] }, { statement: 'Made up.', confidence: 0.9, basedOn: ['F999'] }], unresolved: ['Currency is not stated.'] } },
          ];
        default:
          return [{ tool: 'finish', input: { summary: 'Renamed search, added a price-sorted listing.' } }];
      }
    };
    const client = new FakeChatClient(script);
    const result = await discover({ startUrl: `${base}/`, outDir, allowPrivate: true, model: { client }, budget, sleep: async () => {} });
    const { store, siteId, jobId } = result;
    expect(result.job.status, JSON.stringify(result.job.stages.filter((s) => s.status !== 'completed'))).toBe('completed');

    const model = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const agent = model.agent!;
    expect(agent).toMatchObject({ applied: true, model: 'fake-agent', turns: 4, finished: true });
    expect(agent.proposals.accepted).toEqual(['list_products_by_price']);
    expect(agent.proposals.rejected.map((r) => r.name)).toEqual(['add_to_wishlist', 'list_products_fake', 'list_nowhere']);
    expect(agent.proposals.rejected[0]!.reason).toContain('GraphQL');
    expect(agent.proposals.rejected[1]!.reason).toContain('does not exist');
    expect(agent.proposals.rejected[2]!.reason).toContain('validation failed');
    expect(agent.revisions.some((r) => r.startsWith('revised find_products'))).toBe(true);

    // Policy held on every read the model asked for.
    const turn0 = client.resultsAfter(0);
    expect(turn0).toHaveLength(5);
    expect(turn0[2]!.isError).toBe(false);
    expect(JSON.parse(turn0[2]!.text)).toMatchObject({ status: 200, shape: { description: 'observed: array of objects', items: { properties: { name: { description: 'observed: string' } } } } });
    expect(turn0[3]).toMatchObject({ isError: true });
    expect(turn0[3]!.text).toContain('out of scope');
    expect(turn0[4]).toMatchObject({ isError: true });
    expect(site.requests.some((r) => r.includes('external.example') || r.includes('169.254'))).toBe(false);
    expect(site.posts).toEqual([]);

    // The kept proposal is a capability with model provenance, and it became a validated HTTP tool.
    const cap = model.capabilities.find((c) => c.name === 'list_products_by_price')!;
    expect(cap).toMatchObject({ source: 'model', status: 'inferred', sideEffectClass: 'read', authRequirement: 'none' });
    expect(cap.mechanics.api).toMatchObject({ method: 'GET', urlTemplate: `${base}/api/products`, queryParams: { sort: 'sort' }, credentialed: false });
    expect(cap.confidence).toBeLessThanOrEqual(0.7);
    expect(model.capabilities.some((c) => c.name === 'find_products')).toBe(true);
    expect(model.capabilities.some((c) => c.name === 'search_products')).toBe(false);
    expect(model.capabilities.some((c) => c.name === 'add_to_wishlist' || c.name === 'list_nowhere')).toBe(false);
    expect(model.site.purpose).toMatchObject({ statement: 'A small demo shop with six products.', source: 'model' });
    expect(model.hypotheses.filter((h) => h.source === 'model')).toHaveLength(1);
    expect(model.unresolved).toContain('Currency is not stated.');
    expect(model.entities.find((e) => e.name === 'product')).toMatchObject({ description: 'An item in the fixture catalog.', source: 'model' });

    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const tool = tools.find((t) => t.name === 'list_products_by_price')!;
    expect(tool).toMatchObject({ transport: 'http', sideEffectClass: 'read' });
    expect(tools.some((t) => t.name === 'find_products' || t.name === 'find_products_browser')).toBe(true);
    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.toolId === tool.toolId)!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { data: Array<{ name: string }> }).data[0]!.name).toBe('Product 6');
  }, 240_000);

  it('refuses fixed-page proposals unless a listing returns several results, reminds the model two turns before the budget, drops orphan entities and writes a fallback purpose when finish never comes', async () => {
    const base = site.baseUrl;
    let payload: ReturnType<typeof payloadOf> | undefined;
    const fixed = (name: string, kind: string, mechanics: Record<string, unknown>) => ({
      kind, name, title: name.replace(/_/g, ' '), description: 'One page, no inputs.', entity: null, inputs: [],
      mechanics: { navigateUrl: null, pathTemplate: null, queryParams: [], resultLinkPattern: null, formId: null, fieldElementId: null, api: null, ...mechanics },
      evidence: [{ artifactType: 'PageInventory', refId: `${base}/` }], expectedOutcome: 'Links or a document.', confidence: 0.8,
    });
    const script = (turn: number, req: ChatTurnRequest): ScriptedTurn => {
      payload ??= payloadOf(req);
      if (turn === 0) {
        const getPost = payload.capabilities.find((c) => c.name === 'get_post')!;
        return [
          { tool: 'revise_capability', input: { capabilityId: getPost.capabilityId, name: null, title: null, description: null, entity: null, drop: true, reason: 'Two blog posts and no index; not worth a tool.' } },
          // A detail over one fixed JSON document: refused before any replay.
          { tool: 'propose_capability', input: fixed('get_catalog_snapshot', 'detail', { api: { method: 'GET', urlTemplate: `${base}/api/products`, queryParams: [], graphql: null } }) },
          // A listing over one fixed page that yields six result links: kept.
          { tool: 'propose_capability', input: fixed('list_home_products', 'list', { navigateUrl: `${base}/`, resultLinkPattern: '^/products/\\d+$' }) },
          // A listing over one fixed page that validates with two results: refused.
          { tool: 'propose_capability', input: fixed('list_cars', 'list', { navigateUrl: `${base}/cars`, resultLinkPattern: '^/cars/' }) },
        ];
      }
      return [{ tool: 'get_evidence', input: { kind: 'page', id: `${base}/` } }]; // never finishes
    };
    const client = new FakeChatClient(script);
    const result = await discover({ startUrl: `${base}/`, outDir, allowPrivate: true, model: { client }, budget: { ...budget, maxAgentTurns: 4, maxPagesToInspect: 1, maxProbesTotal: 0 }, sleep: async () => {} });
    expect(result.job.status).toBe('completed');
    const model = (await result.store.readArtifact(result.siteId, result.jobId, 'WebsiteModel', WebsiteModel)).data;
    const agent = model.agent!;
    expect(agent).toMatchObject({ turns: 4, finished: false, stoppedBecause: 'turn budget exhausted' });
    expect(agent.proposals.accepted).toEqual(['list_home_products']);
    expect(agent.proposals.rejected).toEqual([
      { name: 'get_catalog_snapshot', reason: expect.stringContaining('no inputs') },
      { name: 'list_cars', reason: expect.stringContaining('three or more results on replay; it returned 2') },
    ]);
    // The reminder rode along with the results of the turn after which two turns remained, and only then.
    const notesIn = (i: number) => {
      const last = client.requests[i]!.messages.at(-1)!;
      return typeof last.content === 'string' ? [] : last.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    };
    expect(notesIn(1)).toEqual([]);
    expect(notesIn(2)).toEqual([expect.stringMatching(/^Harness note: 2 turns of the budget remain\. Call set_site_summary/)]);
    expect(notesIn(3)).toEqual([]);
    // The heuristic entity whose only capability was dropped is gone from the model and from the purpose.
    expect(agent.revisions).toEqual(expect.arrayContaining([expect.stringMatching(/^dropped get_post/), 'dropped entity post: no capability references it', 'reminded the model with 2 turn(s) left', expect.stringContaining('deterministic fallback')]));
    expect(model.entities.map((e) => e.name)).toEqual(['product']);
    expect(model.site.purpose.source).toBe('heuristic');
    expect(model.site.purpose.statement).toContain('about products');
    expect(model.site.purpose.statement).toContain('list_home_products');
    expect(model.site.purpose.statement).not.toContain('post');
    expect(model.capabilities.some((c) => c.name === 'get_post' || c.name === 'list_cars' || c.name === 'get_catalog_snapshot')).toBe(false);
  }, 240_000);

  it('stops at the turn budget and records why, without failing the stage', async () => {
    const client = new FakeChatClient(() => [{ tool: 'get_evidence', input: { kind: 'template', id: 'nope' } }]);
    const result = await discover({ startUrl: `${site.baseUrl}/`, outDir, allowPrivate: true, model: { client }, budget: { ...budget, maxAgentTurns: 2, maxPagesToInspect: 1, maxProbesTotal: 0 }, sleep: async () => {} });
    const model = (await result.store.readArtifact(result.siteId, result.jobId, 'WebsiteModel', WebsiteModel)).data;
    expect(model.agent).toMatchObject({ applied: true, turns: 2, finished: false, stoppedBecause: 'turn budget exhausted' });
    expect(model.agent!.toolCalls.every((c) => !c.ok)).toBe(true);
    expect(result.job.status).toBe('completed');
  }, 120_000);
});
