import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, Recorder, stage0Scope, stage9Workflows, reconstructWorkflow, ToolExecutor, ToolRegistry } from '../src/index.js';
import { RecordedEvent, RecordingSession, SiteManifest, ToolDefinition, ValidationReport, WorkflowDefinition } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
let siteId: string;
let manifest: SiteManifest;
let store: Awaited<ReturnType<typeof discover>>['store'];

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-record-'));
  const scoped = await discover({ stages: [stage0Scope], startUrl: `${site.baseUrl}/`, outDir, allowPrivate: true });
  siteId = scoped.siteId;
  store = scoped.store;
  manifest = await store.readArtifact(siteId, scoped.jobId, 'SiteManifest', SiteManifest);
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('phase 6: recording and workflows', () => {
  it('records a search-and-open workflow as semantic events with kept values', async () => {
    const recorder = new Recorder({ store, siteId, manifest, startUrl: `${site.baseUrl}/`, keepValues: true, headed: false });
    const { sessionId, page } = await recorder.start();
    await page.getByTestId('search-input').fill('product');
    await page.getByTestId('search-input').press('Enter');
    await page.waitForURL(/\/search\?q=product/);
    await page.getByRole('link', { name: 'Product 1' }).click();
    await page.waitForURL(/\/products\/1$/);
    await page.waitForTimeout(300);
    const session = await recorder.stop();

    expect(session).toMatchObject({ sessionId, status: 'completed', policy: { keepValues: true, allowWrites: true, headed: false } });
    expect(session.pagesVisited).toEqual([`${site.baseUrl}/`, `${site.baseUrl}/search?q=product`, `${site.baseUrl}/products/1`]);
    const events = (await readFile(join(recorder.dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => RecordedEvent.parse(JSON.parse(l)));
    expect(events.map((e) => e.type)).toEqual(['navigation', 'input', 'key', 'click', 'submit', 'navigation', 'click', 'navigation']);
    const input = events[1]!;
    expect(input.input).toMatchObject({ fieldType: 'search', valueKind: 'text', valueLength: 7, redacted: false, value: 'product' });
    expect(input.target?.locators[0]).toMatchObject({ strategy: 'testid', value: '[data-testid="search-input"]', unique: true });
    expect(events[3]!.target).toMatchObject({ name: 'Search', isSubmit: true });
    expect(events[5]!.navigation?.to).toBe(`${site.baseUrl}/search?q=product`);
    // The press's after-state is captured when the implicit submit click fires; if the submission has already begun navigating it is absent.
    expect([undefined, `${site.baseUrl}/`]).toContain(events[2]!.after?.url);
    expect(events[4]!.after?.url).toContain('/search?q=product'); // the submission's after-state is the loaded results page
    const click = events[6]!;
    expect(click.target).toMatchObject({ tag: 'a', role: 'link', name: 'Product 1', consequential: false });
    expect(click.before?.url).toContain('/search?q=product');
    expect(events[7]!.navigation?.to).toBe(`${site.baseUrl}/products/1`);
    expect(events.every((e, i) => e.seq === i && e.status === 'ok')).toBe(true);
    const saved = RecordingSession.parse(JSON.parse(await readFile(join(recorder.dir, 'session.json'), 'utf8')));
    expect(saved.eventCount).toBe(8);
    expect(saved.networkRecords).toBeGreaterThan(0);
    expect((await readFile(join(recorder.dir, 'network.jsonl'), 'utf8'))).toContain('/api/products?q=product');
  }, 60_000);

  it('never records credentials and marks such workflows as not replayable', async () => {
    const recorder = new Recorder({ store, siteId, manifest, startUrl: `${site.baseUrl}/login`, keepValues: true, headed: false });
    const { page } = await recorder.start();
    await page.getByLabel('Email').fill('person@example.com');
    await page.getByLabel('Password').fill('hunter2-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(500);
    await recorder.stop();
    const raw = await readFile(join(recorder.dir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('person@example.com');
    const events = raw.split('\n').filter(Boolean).map((l) => RecordedEvent.parse(JSON.parse(l)));
    const inputs = events.filter((e) => e.type === 'input');
    expect(inputs.map((e) => [e.input?.fieldType, e.input?.redacted, e.input?.valueLength])).toEqual([['email', true, 18], ['password', true, 14]]);
    const submit = events.find((e) => e.type === 'click')!;
    expect(submit.target).toMatchObject({ name: 'Sign in', isSubmit: true, formMethod: 'post', consequential: true });
    expect(site.posts).toContain('/session');

    const session = RecordingSession.parse(JSON.parse(await readFile(join(recorder.dir, 'session.json'), 'utf8')));
    const wf = reconstructWorkflow(session, events, 1000)!;
    expect(wf).toMatchObject({ replayable: false, authRequirement: 'session', requiresApproval: true });
    expect(wf.sideEffectClass).not.toBe('read');
    expect(wf.inputs).toEqual([]);
    expect(wf.reasons.some((r) => r.includes('password'))).toBe(true);
  }, 60_000);

  it('reconstructs workflows, generates a replayable tool, validates it, and keeps the write workflow unpublishable', async () => {
    const result = await discover({
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      model: { enabled: false },
      budget: { maxPages: 24, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 6, maxProbesPerPage: 3, maxProbesTotal: 6, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
      sleep: async () => {},
    });
    expect(result.job.status).toBe('completed');
    const workflows = (await result.store.readArtifact(result.siteId, result.jobId, 'WorkflowDefinition', WorkflowDefinition)).data;
    expect(workflows.stats).toMatchObject({ recordings: 2, workflows: 2, replayable: 1, requiringApproval: 1 });
    const search = workflows.workflows.find((w) => w.name === 'workflow_search_and_open')!;
    expect(search.steps.map((s) => s.op)).toEqual(['navigate', 'fill', 'press', 'wait', 'click-result', 'wait', 'wait', 'extract']);
    expect(search.inputs.map((i) => i.name)).toEqual(['search_products', 'result_title', 'result_index']);
    expect(search.inputs[0]).toMatchObject({ required: true, example: 'product', param: 'q' });
    expect(search.inputs[1]).toMatchObject({ required: false, example: 'Product 1' });
    expect(search.steps[4]).toMatchObject({ op: 'click-result', hrefPattern: '^/products/[^/?#]+/?$', titleFrom: 'result_title', indexFrom: 'result_index' });
    expect(search).toMatchObject({ sideEffectClass: 'read', authRequirement: 'none', requiresApproval: false, replayable: true });
    expect(search.stepEvidence[1]).toEqual({ stepIndex: 1, eventSeqs: [1] });
    expect(search.evidence[0]).toMatchObject({ artifactType: 'RecordingSession' });

    const tools = (await result.store.readArtifact(result.siteId, result.jobId, 'ToolDefinition', ToolDefinition)).data.tools;
    const searchTool = tools.find((t) => t.name === 'workflow_search_and_open')!;
    expect(searchTool).toMatchObject({ transport: 'browser', sideEffectClass: 'read', idempotent: true });
    expect(searchTool.inputSchema).toMatchObject({ required: ['search_products'] });
    expect(Object.keys((searchTool.inputSchema['properties'] as Record<string, unknown>)).sort()).toEqual(['result_index', 'result_title', 'search_products']);
    const loginTool = tools.find((t) => t.name.startsWith('workflow_') && t.name !== 'workflow_search_and_open')!;
    expect(loginTool.sideEffectClass).not.toBe('read');

    const report = (await result.store.readArtifact(result.siteId, result.jobId, 'ValidationReport', ValidationReport)).data;
    const v = report.tools.find((t) => t.name === 'workflow_search_and_open')!;
    expect(v.verdict, v.failureReasons.join('; ')).toBe('validated');
    expect((v.runs[0]!.output as { title: string; url: string }).title).toBe('Product 1');
    const skipped = report.tools.find((t) => t.toolId === loginTool.toolId)!;
    expect(skipped.verdict).toBe('skipped');
    expect(report.stats.skipped).toBeGreaterThanOrEqual(1);

    const registry = new ToolRegistry(result.store, result.siteId);
    const published = await registry.publish({ names: ['workflow_search_and_open', loginTool.name] });
    expect(published.published).toEqual(['workflow_search_and_open']);
    expect(published.skipped[0]?.reason).toMatch(/validation|side effect/);
    const executor = new ToolExecutor({ store: result.store, siteId: result.siteId });
    try {
      // The recorded result is only the default: a different query opens its first result, a title or an index picks another.
      const recorded = await executor.call('workflow_search_and_open', { search_products: 'product', result_title: 'Product 1' });
      expect((recorded.output as { title: string }).title).toBe('Product 1');
      const first = await executor.call('workflow_search_and_open', { search_products: 'product 3' });
      expect(first.ok).toBe(true);
      expect((first.output as { title: string }).title).toBe('Product 3');
      const byTitle = await executor.call('workflow_search_and_open', { search_products: 'product', result_title: 'product 5' });
      expect((byTitle.output as { title: string }).title).toBe('Product 5');
      const byIndex = await executor.call('workflow_search_and_open', { search_products: 'product', result_index: 2 });
      expect((byIndex.output as { title: string }).title).toBe('Product 2');
      const none = await executor.call('workflow_search_and_open', { search_products: 'zzzz' });
      expect(none).toMatchObject({ ok: false, errorCode: 'LOCATOR_MISSING' });
      expect(none.errorMessage).toContain('no result links');
    } finally {
      await executor.close();
    }
  }, 300_000);
});
