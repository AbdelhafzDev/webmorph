import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover } from '../src/index.js';
import { FakeChatClient, type ChatTurnRequest, type ScriptedTurn } from '../src/model/llm.js';
import { generateApiTool } from '../src/tools/generate.js';
import { ApiCandidates, NetworkEvidence, ToolDefinition, ValidationReport, WebsiteModel } from '../src/schemas/index.js';
import type { Capability, WebsiteModelData } from '../src/schemas/websiteModel.js';
import { EVENTS_WIDGET_COOKIE, startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-cookie-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

const budget = { maxPages: 30, maxDepth: 1, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 2, maxProbesPerPage: 2, maxProbesTotal: 2, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1, maxAgentInspections: 0 };
const options = { pageLoadTimeoutMs: 15_000, settleTimeoutMs: 1000 };

const model = (): WebsiteModelData => ({ site: { origin: 'https://events.test', purpose: { statement: 'x', confidence: 0.4, source: 'heuristic' }, frameworks: [], renderMode: 'static', siteBlocked: false, robots: 'found' }, pageTypes: [], entities: [], capabilities: [], navigation: { primaryLinks: [] }, authentication: { sessionAvailable: false }, facts: [], hypotheses: [], unresolved: [], enrichment: { applied: false, rejected: [] } });
const capability = (api: Partial<NonNullable<Capability['mechanics']['api']>>): Capability => ({
  capabilityId: 'cap-events', kind: 'list', name: 'list_events', title: 'List events', description: 'List events.', status: 'observed', confidence: 0.7, pageUrl: 'https://events.test/events', entity: 'event', inputs: [], outputs: [], preconditions: [], expectedOutcome: 'events', sideEffectClass: 'read', authRequirement: 'none',
  mechanics: { navigateUrl: 'https://events.test/events', api: { source: 'observed', method: 'GET', urlTemplate: 'https://events.test/api/events', queryParams: {}, authRequired: false, credentialed: false, ...api } },
  evidence: [{ artifactType: 'ApiCandidates', refId: 'api-1' }],
});

/** The evidence payload the harness sent on turn 0, parsed. */
function payloadOf(req: ChatTurnRequest): { apiCandidates: Array<{ candidateId: string; urlTemplate: string; credentialed: boolean; credentialSource?: string }> } {
  const first = req.messages[0]!;
  const text = typeof first.content === 'string' ? first.content : (first.content[0] as { text: string }).text;
  return JSON.parse(text.slice(text.indexOf('{'))) as ReturnType<typeof payloadOf>;
}

describe('generateApiTool and credential sources (D21 addendum)', () => {
  it('generates a tool for a cookie-only API whose precondition says the replay decides, and none for a header-credentialed one', () => {
    const cookie = generateApiTool(capability({ credentialed: true, credentialSource: 'cookie' }), model(), options)!;
    expect(cookie).toMatchObject({ name: 'list_events', transport: 'http', authRequirement: 'none' });
    expect(cookie.preconditions.find((p) => p.kind === 'no-auth')!.detail).toContain('cookie-less replay');
    expect(cookie.errorCases.some((e) => e.code === 'PERMISSION_DENIED' && e.when.includes('401 or 403'))).toBe(true);
    expect(cookie.program[0]).toMatchObject({ op: 'http', method: 'GET', url: 'https://events.test/api/events' });
    expect(JSON.stringify(cookie)).not.toContain('credentialRef');
    expect(generateApiTool(capability({ credentialed: true, credentialSource: 'header' }), model(), options)).toBeNull();
    expect(generateApiTool(capability({ credentialed: true }), model(), options)).toBeNull(); // an older model without the source stays unpromotable
    expect(generateApiTool(capability({ credentialed: false }), model(), options)!.preconditions.find((p) => p.kind === 'no-auth')!.detail).toBe('endpoint answered without credentials during discovery');
  });
});

describe('a widget cookie on the events listing', () => {
  it('flags the feed by cookie only, still generates its HTTP tool, and the cookie-less replay validates it', async () => {
    const result = await discover({ startUrl: `${site.baseUrl}/events`, outDir, allowPrivate: true, model: { enabled: false }, budget, sleep: async () => {} });
    const { store, siteId, jobId } = result;
    expect(result.job.status, JSON.stringify(result.job.stages.filter((s) => s.status !== 'completed'))).toBe('completed');

    const network = (await store.readArtifact(siteId, jobId, 'NetworkEvidence', NetworkEvidence)).data;
    const feed = network.records.find((r) => r.url.endsWith('/api/events'))!;
    expect(feed).toMatchObject({ method: 'GET', status: 200, credentialed: true });
    expect(feed.cookieNames).toContain(EVENTS_WIDGET_COOKIE);
    expect(feed.credentialHeaders ?? []).toEqual([]);

    const candidates = (await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates)).data.candidates;
    const byPath = (p: string) => candidates.find((c) => c.pathPattern === p)!;
    expect(byPath('/api/events')).toMatchObject({ credentialed: true, credentialSource: 'cookie', sideEffectHint: 'read' });
    expect(byPath('/api/events').note).toContain('cookie-less replay decides');
    expect(byPath('/api/events/mine')).toMatchObject({ credentialed: true, credentialSource: 'cookie' });
    expect(byPath('/api/events/digest')).toMatchObject({ credentialed: true, credentialSource: 'header' });
    expect(byPath('/api/events/digest').note).toContain('never promoted');

    const websiteModel = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const list = websiteModel.capabilities.find((c) => c.kind === 'list' && c.entity === 'event')!;
    expect(list, 'the events listing should be linked to the cookie-flagged feed').toBeDefined();
    expect(list.mechanics.api).toMatchObject({ urlTemplate: `${site.baseUrl}/api/events`, credentialed: true, credentialSource: 'cookie' });
    expect(websiteModel.facts.some((f) => f.statement.includes('/api/events ') && f.statement.includes('session-like cookie'))).toBe(true);

    const definition = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data;
    const tool = definition.tools.find((t) => t.transport === 'http' && t.program.some((s) => s.op === 'http' && s.url === `${site.baseUrl}/api/events`))!;
    expect(tool, 'an HTTP tool over the cookie-flagged feed').toBeDefined();
    expect(tool.name).toBe(list.name);
    expect(tool.preconditions.find((p) => p.kind === 'no-auth')!.detail).toContain('cookie-less replay');
    expect(definition.tools.some((t) => t.program.some((s) => s.op === 'http' && s.url.includes('/api/events/digest')))).toBe(false);
    expect(definition.apiGaps.some((g) => g.capabilityId === list.capabilityId)).toBe(false);

    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.toolId === tool.toolId)!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { data: unknown[] }).data).toHaveLength(3);
    expect(site.eventCalls).toContain('with-cookie'); // the browser sent the widget cookie
    expect(site.eventCalls).toContain('without-cookie'); // the replay did not
  }, 240_000);

  it('lets the harness propose over a cookie-only candidate, fails one whose endpoint needs the cookie with PERMISSION_DENIED, and refuses a header-credentialed one', async () => {
    const base = site.baseUrl;
    let payload: ReturnType<typeof payloadOf> | undefined;
    const script = (turn: number, req: ChatTurnRequest): ScriptedTurn => {
      payload ??= payloadOf(req);
      const candidate = (path: string) => payload!.apiCandidates.find((c) => c.urlTemplate === `${base}${path}`)!;
      const proposal = (name: string, path: string) => ({
        kind: 'list', name, title: 'Events', description: 'List fixture events.', entity: 'event',
        inputs: [{ name: 'limit', type: 'integer', required: true, description: 'How many events to return.', example: '2', source: 'url-param', param: 'limit' }],
        mechanics: { navigateUrl: null, pathTemplate: null, queryParams: [], resultLinkPattern: null, formId: null, fieldElementId: null, api: { method: 'GET', urlTemplate: `${base}${path}`, queryParams: [{ param: 'limit', input: 'limit' }], graphql: null } },
        evidence: [{ artifactType: 'ApiCandidates', refId: candidate(path).candidateId }],
        expectedOutcome: 'A JSON array of events.', confidence: 0.8,
      });
      if (turn === 0) {
        expect(candidate('/api/events')).toMatchObject({ credentialed: true, credentialSource: 'cookie' });
        expect(candidate('/api/events/digest')).toMatchObject({ credentialed: true, credentialSource: 'header' });
        return [
          { tool: 'propose_capability', input: proposal('list_upcoming_events', '/api/events') },
          { tool: 'propose_capability', input: proposal('list_my_events', '/api/events/mine') },
          { tool: 'propose_capability', input: proposal('list_event_digest', '/api/events/digest') },
        ];
      }
      return [{ tool: 'finish', input: { summary: 'Proposed the events feed.' } }];
    };
    const client = new FakeChatClient(script);
    const result = await discover({ startUrl: `${base}/events`, outDir, allowPrivate: true, model: { client }, budget, sleep: async () => {} });
    const { store, siteId, jobId } = result;
    expect(result.job.status).toBe('completed');
    const websiteModel = (await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const agent = websiteModel.agent!;
    expect(agent).toMatchObject({ finished: true, turns: 2 });
    expect(agent.proposals.accepted).toEqual(['list_upcoming_events']);
    expect(agent.proposals.rejected).toEqual([
      { name: 'list_my_events', reason: expect.stringContaining('PERMISSION_DENIED') },
      { name: 'list_event_digest', reason: expect.stringContaining('authorization-style header') },
    ]);
    const cap = websiteModel.capabilities.find((c) => c.name === 'list_upcoming_events')!;
    expect(cap.mechanics.api).toMatchObject({ credentialed: true, credentialSource: 'cookie', candidateId: payload!.apiCandidates.find((c) => c.urlTemplate === `${base}/api/events`)!.candidateId });
    const tools = (await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const tool = tools.find((t) => t.name === 'list_upcoming_events')!;
    expect(tool).toMatchObject({ transport: 'http' });
    expect(tool.preconditions.find((p) => p.kind === 'no-auth')!.detail).toContain('cookie-less replay');
    const report = (await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.toolId === tool.toolId)!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { data: unknown[] }).data).toHaveLength(2);
    expect(tools.some((t) => t.name === 'list_my_events' || t.name === 'list_event_digest')).toBe(false);
  }, 240_000);
});
