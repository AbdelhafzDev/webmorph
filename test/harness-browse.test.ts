import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover } from '../src/index.js';
import { FakeChatClient, type ChatTurnRequest, type ScriptedTurn } from '../src/model/llm.js';
import { ApiCandidates, ToolDefinition, ValidationReport, WebsiteModel } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-harness-browse-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

const budget = { maxPages: 5, maxDepth: 1, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 1, maxProbesPerPage: 0, maxProbesTotal: 0, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1, maxAgentInspections: 3, maxAgentActions: 6, maxAgentTurns: 10 };

type Summary = { url: string; elements: Array<{ elementId: string; name?: string; text?: string }>; requests: Array<{ method: string; url: string; allowedAs?: string }>; headings: string[] };

/** The successful tool results the harness sent back on the previous turn, parsed. */
function lastResults(req: ChatTurnRequest): unknown[] {
  const last = req.messages[req.messages.length - 1];
  if (!last || typeof last.content === 'string') return [];
  return last.content.flatMap((b) => (b.type === 'tool_result' && typeof b.content === 'string' && !b.is_error ? [JSON.parse(b.content) as unknown] : []));
}

describe('the harness drives the browser (D27)', () => {
  it('opens a client-rendered app, acts through the guardrails, reads the results and keeps a workflow only when its program replays', async () => {
    const base = site.baseUrl;
    let items: { item: string } | undefined;
    const find = (s: Summary, name: string) => s.elements.find((e) => (e.name ?? '').startsWith(name) || e.text === name)?.elementId ?? 'el-missing';
    const script = (turn: number, req: ChatTurnRequest): ScriptedTurn => {
      const prev = lastResults(req)[0] as Summary | undefined;
      switch (turn) {
        case 0:
          return [{ tool: 'browse_open', input: { url: `${base}/app` } }, { tool: 'browse_open', input: { url: 'https://external.example/' } }];
        case 1:
          return [{ tool: 'browse_act', input: { action: 'click', elementId: find(prev!, 'Category'), value: null, key: null } }];
        case 2:
          return [{ tool: 'browse_act', input: { action: 'click', elementId: find(prev!, 'Cheap'), value: null, key: null } }];
        case 3:
          return [
            // A consequential control is refused before the click; the search button is not.
            { tool: 'browse_act', input: { action: 'click', elementId: find(prev!, 'Buy now'), value: null, key: null } },
            { tool: 'browse_act', input: { action: 'click', elementId: find(prev!, 'Find trips'), value: null, key: null } },
          ];
        case 4:
          return [{ tool: 'browse_read', input: { mode: 'items', selector: null } }];
        case 5: {
          items = (lastResults(req)[0] as { items: { item: string } }).items;
          const proposal = {
            kind: 'search',
            name: 'find_trips',
            title: 'Find trips',
            description: 'Pick a category and list the trips with price and link.',
            entity: 'trip',
            inputs: [{ name: 'category', type: 'string', required: true, description: 'Cheap or Premium', example: 'Cheap', actionIndex: 2, mode: 'locator' }],
            extract: { kind: 'item-list', item: items.item, fields: [{ name: 'name', selector: 'h3.name', attr: null }, { name: 'price', selector: 'span.price', attr: null }, { name: 'url', selector: 'a.more', attr: 'href' }], hrefPattern: null, maxItems: 50 },
            resultUrlPattern: null,
            expectedOutcome: 'Trips of the category with name, price and link.',
            confidence: 0.9,
            evidence: [{ artifactType: 'PageModel', refId: `${base}/app` }],
          };
          return [
            { tool: 'propose_entity', input: { name: 'trip', plural: 'trips', description: 'A trip the finder offers.', detailPageTypeId: null, listPageTypeIds: [], confidence: 0.8 } },
            // A field whose selector matches nothing is empty on every replayed result: rejected with the field named.
            { tool: 'propose_workflow', input: { ...proposal, name: 'find_trips_blank', extract: { ...proposal.extract, fields: [...proposal.extract.fields, { name: 'cost', selector: 'span.cost', attr: null }] } } },
            { tool: 'propose_workflow', input: { ...proposal, name: 'find_trips_fake', evidence: [{ artifactType: 'PageModel', refId: `${base}/nowhere` }] } },
            { tool: 'propose_workflow', input: { ...proposal, name: 'find_trips_wrong', inputs: [{ ...proposal.inputs[0]!, example: 'Expensive' }] } },
            { tool: 'propose_workflow', input: proposal },
          ];
        }
        default:
          return [{ tool: 'finish', input: { summary: 'Recorded the trip search as a tool.' } }];
      }
    };
    const client = new FakeChatClient(script);
    const result = await discover({ startUrl: `${base}/app`, outDir, allowPrivate: true, model: { client }, budget, sleep: async () => {} });
    expect(result.job.status, JSON.stringify(result.job.stages.filter((s) => s.status !== 'completed'))).toBe('completed');
    const { store, siteId, jobId } = result;

    // What the model saw: the app's own POSTs on load and after the search, as app requests; the refusals as tool errors.
    const open = client.resultsAfter(0);
    expect(open[0]!.isError).toBe(false);
    expect((JSON.parse(open[0]!.text) as Summary).requests).toContainEqual(expect.objectContaining({ method: 'POST', url: expect.stringContaining('/api/session'), allowedAs: 'app-request' }));
    expect(open[1]).toMatchObject({ isError: true });
    expect(open[1]!.text).toContain('out of scope');
    const act3 = client.resultsAfter(3);
    expect(act3[0]).toMatchObject({ isError: true });
    expect(act3[0]!.text).toContain('consequential');
    expect(act3[1]!.isError).toBe(false);
    expect((JSON.parse(act3[1]!.text) as Summary).headings).toContain('3 trips');
    expect(site.buys).toEqual([]);

    // Static front-end files (a translation file here) never become API candidates.
    const candidates = (await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates)).data.candidates;
    expect(candidates.some((c) => c.urlTemplate.includes('/assets/'))).toBe(false);
    expect(client.requests[0]!.system).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
    const model = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const agent = model.agent!;
    expect(agent).toMatchObject({ finished: true, turns: 7 });
    expect(agent.proposals.accepted).toEqual(['find_trips']);
    expect(agent.proposals.rejected.map((r) => r.name)).toEqual(['find_trips_blank', 'find_trips_fake', 'find_trips_wrong']);
    expect(agent.proposals.rejected[0]!.reason).toContain('fields cost were empty in every result');
    expect(agent.proposals.rejected[1]!.reason).toContain('does not exist');
    expect(agent.proposals.rejected[2]!.reason).toContain('Expensive');
    expect(agent.toolCalls.filter((c) => c.tool.startsWith('browse_') && c.ok)).toHaveLength(5);
    const cap = model.capabilities.find((c) => c.name === 'find_trips')!;
    expect(cap).toMatchObject({ source: 'model', sideEffectClass: 'read', entity: 'trip' });
    expect(Array.isArray(cap.mechanics.program)).toBe(true);
    expect(model.entities.find((e) => e.name === 'trip')).toMatchObject({ source: 'model' });

    // The workflow became a browser tool with a program, validated by replay in the same job.
    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const tool = tools.find((t) => t.name === 'find_trips')!;
    expect(tool).toMatchObject({ transport: 'browser', sideEffectClass: 'read' });
    expect(tool.inputSchema).toMatchObject({ required: ['category'] });
    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    expect(report.tools.find((t) => t.toolId === tool.toolId)).toMatchObject({ verdict: 'validated' });
    expect(site.buys).toEqual([]);
  }, 180_000);
});
