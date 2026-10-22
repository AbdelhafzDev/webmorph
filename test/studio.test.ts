import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { discover, PHASE3_STAGES, StudioServer, Recorder, stage0Scope } from '../src/index.js';
import { SiteManifest } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
let siteId: string;
let jobId: string;
let studio: StudioServer;
let base: string;
let browser: Browser;

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-studio-'));
  const result = await discover({
    stages: PHASE3_STAGES,
    startUrl: `${site.baseUrl}/`,
    outDir,
    allowPrivate: true,
    model: { enabled: false },
    budget: { maxPages: 24, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 6, maxProbesPerPage: 3, maxProbesTotal: 6, settleTimeoutMs: 1000, pageLoadTimeoutMs: 15_000, validationRuns: 1 },
    sleep: async () => {},
  });
  siteId = result.siteId;
  jobId = result.jobId;
  const manifest = await result.store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
  const recorder = new Recorder({ store: result.store, siteId, manifest, startUrl: `${site.baseUrl}/`, keepValues: true, headed: false });
  const { page } = await recorder.start();
  await page.getByRole('link', { name: 'About' }).first().click();
  await page.waitForURL(/\/about$/);
  await recorder.stop();
  studio = new StudioServer({ store: result.store });
  base = await studio.start();
  browser = await chromium.launch();
}, 240_000);
afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('phase 7: studio', () => {
  it('serves the UI and the read API over the artifact store', async () => {
    const home = await fetch(base + '/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('WebMorph Studio');

    const sites = await get('/api/sites');
    expect(sites.status).toBe(200);
    expect((sites.body as Array<{ siteId: string; recordings: number }>).find((s) => s.siteId === siteId)).toMatchObject({ recordings: 1, published: 0 });

    const detail = await get(`/api/sites/${siteId}`);
    expect((detail.body as { jobs: Array<{ jobId: string; status: string }> }).jobs[0]).toMatchObject({ jobId, status: 'completed' });

    const job = await get(`/api/sites/${siteId}/jobs/${jobId}`);
    expect((job.body as { artifacts: string[] }).artifacts).toEqual(expect.arrayContaining(['SiteManifest', 'PageModel', 'ToolDefinition', 'ValidationReport']));

    const model = await get(`/api/sites/${siteId}/jobs/${jobId}/artifacts/WebsiteModel`);
    expect((model.body as { data: { capabilities: Array<{ name: string }> } }).data.capabilities.map((c) => c.name)).toContain('search_products');
    expect((await get(`/api/sites/${siteId}/jobs/${jobId}/artifacts/NotAType`)).status).toBe(400);

    const probes = await get(`/api/sites/${siteId}/jobs/${jobId}/evidence/interactions`);
    expect(Array.isArray(probes.body)).toBe(true);
    expect((probes.body as unknown[]).length).toBeGreaterThan(0);

    const pageModel = (await get(`/api/sites/${siteId}/jobs/${jobId}/artifacts/PageModel`)).body as { data: { pages: Array<{ screenshot?: { path: string } }> } };
    const shot = pageModel.data.pages.find((p) => p.screenshot)!.screenshot!.path;
    const img = await get(`/api/sites/${siteId}/jobs/${jobId}/${shot}`);
    expect(img.status).toBe(200);
    expect(img.type).toBe('image/png');
    expect((await get(`/api/sites/${siteId}/jobs/${jobId}/blobs/../../site.json`)).status).toBeGreaterThanOrEqual(400);
    expect((await get(`/api/sites/${siteId}/jobs/${jobId}/blobs/%2e%2e/%2e%2e/site.json`)).status).toBeGreaterThanOrEqual(400);

    const recordings = await get(`/api/sites/${siteId}/recordings`);
    const session = (recordings.body as Array<{ sessionId: string; eventCount: number }>)[0]!;
    expect(session.eventCount).toBeGreaterThanOrEqual(3);
    const rec = await get(`/api/sites/${siteId}/recordings/${session.sessionId}`);
    expect((rec.body as { events: Array<{ type: string }> }).events.map((e) => e.type)).toContain('click');
  });

  it('publishes, changes status, calls tools and starts runs through the write API', async () => {
    const published = await post(`/api/sites/${siteId}/publish`, { jobId });
    expect(published.status).toBe(200);
    expect((published.body as { published: string[] }).published).toContain('search_products');

    const call = await post(`/api/sites/${siteId}/tools/search_products/call`, { inputs: { query: 'product' } });
    expect(call.status).toBe(200);
    expect((call.body as { ok: boolean; output: { count: number } }).output.count).toBe(6);

    const disabled = await post(`/api/sites/${siteId}/tools/search_products/status`, { status: 'disabled', reason: 'test' });
    expect((disabled.body as { status: string }).status).toBe('disabled');
    const refused = await post(`/api/sites/${siteId}/tools/search_products/call`, { inputs: { query: 'product' } });
    expect((refused.body as { ok: boolean; errorCode: string }).errorCode).toBe('TOOL_UNAVAILABLE');
    expect((await post(`/api/sites/${siteId}/tools/search_products/status`, { status: 'bogus' })).status).toBe(400);
    await post(`/api/sites/${siteId}/tools/search_products/status`, { status: 'published', reason: 'test' });

    const run = await post('/api/discover', { url: `${site.baseUrl}/about`, options: { stages: 'phase1', maxPages: 3, allowPrivate: true, model: false, minDelayMs: 0 } });
    expect(run.status).toBe(200);
    const runId = (run.body as { runId: string }).runId;
    let record: { status: string; siteId?: string; log: string[] } = { status: 'running', log: [] };
    for (let i = 0; i < 60 && record.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      record = (await get(`/api/runs/${runId}`)).body as typeof record;
    }
    expect(record.status).toBe('completed');
    expect(record.siteId).toBe(siteId);
    expect(record.log.some((l) => l.includes('stage3-crawl: completed'))).toBe(true);
  }, 120_000);

  it('renders sites, tools and publishing in the browser UI', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + '/');
      await page.getByRole('link', { name: siteId }).last().click();
      await page.getByRole('combobox', { name: 'job' }).selectOption(jobId);
      await page.getByRole('button', { name: 'tools' }).click();
      await page.getByText('search_products', { exact: true }).waitFor();
      await page.getByText('get_product', { exact: true }).waitFor();
      expect(await page.getByText('validated').count()).toBeGreaterThanOrEqual(3);
      await page.getByRole('button', { name: 'Publish all validated' }).click();
      await page.getByText('published: ').waitFor();
      await page.getByRole('button', { name: 'registry' }).click();
      await page.getByText('"status": "published"').first().waitFor();
      await page.getByRole('button', { name: 'recordings' }).click();
      await page.getByRole('button', { name: 'Show timeline' }).click();
      await page.getByText('About').first().waitFor();
      await page.getByRole('button', { name: 'model' }).click();
      await page.getByText('Capabilities').waitFor();
      expect(page.url()).toContain('#/site/');
    } finally {
      await page.close();
    }
  }, 60_000);
});
