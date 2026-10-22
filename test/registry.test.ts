import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileArtifactStore } from '../src/core/store.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { makeEnvelope, DEFAULT_BUDGET } from '../src/stages/shared.js';
import { SiteManifest, ToolDefinition, ValidationReport, type ToolSpec } from '../src/schemas/index.js';

let outDir: string;
let store: FileArtifactStore;
const siteId = 'shop-test-0000000000';
const jobId = '20261020T000000Z-test0001';

function tool(name: string, extra: Partial<ToolSpec> = {}): ToolSpec {
  return {
    toolId: `tool-${name}`,
    name,
    version: '1.0.0',
    title: name,
    description: 'd',
    capabilityId: `cap-${name}`,
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    timeoutMs: 10_000,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, required: [] },
    preconditions: [],
    program: [{ op: 'navigate', url: 'https://shop.test/list' }],
    expectedOutcome: 'x',
    errorCases: [],
    examples: [{ inputs: {} }],
    evidence: [],
    status: 'draft',
    ...extra,
  };
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-registry-'));
  store = new FileArtifactStore(outDir);
  await mkdir(store.siteDir(siteId), { recursive: true });
  await writeFile(join(store.siteDir(siteId), 'site.json'), JSON.stringify({ siteId, origin: 'https://shop.test', latestJobId: jobId, jobIds: [jobId], updatedAt: new Date().toISOString() }));
  const common = { siteId, jobId, now: () => new Date(), sources: [] };
  const manifest = SiteManifest.parse({ ...makeEnvelope({ ...common, type: 'SiteManifest', schemaVersion: '1.2.0', stage: 'stage0-scope' }), data: { analysisVersion: 'x', startUrl: 'https://shop.test/', normalizedStartUrl: 'https://shop.test/', scope: { origin: 'https://shop.test', allowedHosts: ['shop.test'], allowPrivateNetwork: false, respectRobots: true, userAgent: 'ua' }, budget: DEFAULT_BUDGET, prohibited: { hosts: [], pathPatterns: [], actions: [] }, auth: { mode: 'none' }, resolvedAddresses: ['93.184.216.34'] } });
  await store.writeArtifact(manifest);
  const tools = [tool('list_items'), tool('get_item', { program: [{ op: 'navigate', url: 'https://shop.test/items/{{id}}' }] }), tool('search_items')];
  const definition = ToolDefinition.parse({ ...makeEnvelope({ ...common, type: 'ToolDefinition', schemaVersion: '1.0.0', stage: 'stage10-generate' }), data: { tools, stats: { total: 3, byKind: {}, bySideEffect: { read: 3 } } } });
  await store.writeArtifact(definition);
  const run = { runId: 'r', startedAt: new Date().toISOString(), durationMs: 1, ok: true, steps: [] };
  const report = ValidationReport.parse({ ...makeEnvelope({ ...common, type: 'ValidationReport', schemaVersion: '1.0.0', stage: 'stage10-validate' }), data: { runsPerTool: 1, tools: [
    { toolId: 'tool-list_items', name: 'list_items', inputs: {}, runs: [run], checks: [], verdict: 'validated', statusAfter: 'validated', failureReasons: [] },
    { toolId: 'tool-get_item', name: 'get_item', inputs: {}, runs: [run], checks: [], verdict: 'validated', statusAfter: 'validated', failureReasons: [] },
    { toolId: 'tool-search_items', name: 'search_items', inputs: {}, runs: [run], checks: [], verdict: 'failed', statusAfter: 'draft', failureReasons: ['output-nonempty: nothing'] },
  ], stats: { total: 3, validated: 2, failed: 1, byErrorCode: {} } } });
  await store.writeArtifact(report);
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('ToolRegistry', () => {
  it('publishes only validated tools unless forced, pinned to their job and artifacts', async () => {
    const registry = new ToolRegistry(store, siteId);
    const result = await registry.publish({});
    expect(result.published.sort()).toEqual(['get_item', 'list_items']);
    expect(result.skipped).toEqual([{ name: 'search_items', reason: 'validation failed: output-nonempty: nothing' }]);
    const entry = (await registry.get('list_items'))!;
    expect(entry.status).toBe('published');
    expect(entry.pinned.jobId).toBe(jobId);
    expect(entry.pinned.toolDefinitionArtifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.pinned.validationReportArtifactId).toBeDefined();
    expect(entry.history[0]).toMatchObject({ from: 'validated', to: 'published' });
    const forced = await registry.publish({ names: ['search_items'], force: true });
    expect(forced.published).toEqual(['search_items']);
    expect((await registry.get('search_items'))?.history[0]?.reason).toContain('forced');
  });

  it('tracks status changes and degrades after consecutive site-change failures', async () => {
    const registry = new ToolRegistry(store, siteId);
    await registry.setStatus('list_items', 'disabled', 'maintenance');
    expect((await registry.get('list_items'))?.status).toBe('disabled');
    await registry.setStatus('list_items', 'published', 'back');
    expect((await registry.get('list_items'))?.calls.consecutiveFailures).toBe(0);

    expect(await registry.recordCall('list_items', { ok: false, errorCode: 'INPUT_INVALID', errorMessage: 'bad' })).toBe('published');
    expect(await registry.recordCall('list_items', { ok: false, errorCode: 'SITE_CHANGED', errorMessage: 'moved' })).toBe('published');
    expect(await registry.recordCall('list_items', { ok: true })).toBe('published');
    expect((await registry.get('list_items'))?.calls.consecutiveFailures).toBe(0);
    expect(await registry.recordCall('list_items', { ok: false, errorCode: 'NOT_FOUND', errorMessage: '404' })).toBe('published');
    expect(await registry.recordCall('list_items', { ok: false, errorCode: 'LOCATOR_MISSING', errorMessage: 'gone' })).toBe('degraded');
    const entry = (await registry.get('list_items'))!;
    expect(entry.calls).toMatchObject({ total: 5, ok: 1, failed: 4, consecutiveFailures: 2 });
    expect(entry.history.at(-1)).toMatchObject({ from: 'published', to: 'degraded' });

    // A tool whose URL takes user-supplied path inputs does not count 404s against itself.
    expect(await registry.recordCall('get_item', { ok: false, errorCode: 'NOT_FOUND', errorMessage: '404' })).toBe('published');
    expect(await registry.recordCall('get_item', { ok: false, errorCode: 'NOT_FOUND', errorMessage: '404' })).toBe('published');
    expect((await registry.get('get_item'))?.calls.consecutiveFailures).toBe(0);
  });

  it('round-trips through disk and lists only published tools', async () => {
    const registry = new ToolRegistry(store, siteId);
    const published = await registry.listPublished();
    expect(published.map((t) => t.tool.name).sort()).toEqual(['get_item', 'search_items']);
    const all = await registry.list();
    expect(all).toHaveLength(3);
  });
});
