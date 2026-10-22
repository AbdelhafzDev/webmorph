import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, PHASE2_STAGES } from '../src/index.js';
import { ElementInventory, InspectionPlan, InteractionEvidence, PageModel, StateTransition } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-browser-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('phase 2: browser inspection and interaction probes', () => {
  it('plans, inspects and probes the fixture site without ever performing a write', async () => {
    const result = await discover({
      stages: PHASE2_STAGES,
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      budget: { maxPages: 30, maxDepth: 2, minDelayMs: 0, maxResponseBytes: 200_000, maxPagesToInspect: 14, maxProbesPerPage: 5, maxProbesTotal: 14, settleTimeoutMs: 1500, pageLoadTimeoutMs: 15_000, browserConcurrency: 2 },
      sleep: async () => {},
    });
    const { store, siteId, jobId, job } = result;
    expect(job.status).toBe('completed');
    expect(Object.fromEntries(job.stages.map((s) => [s.id, s.status]))).toEqual({
      'stage0-scope': 'completed',
      'stage2-sitemap': 'completed',
      'stage3-crawl': 'completed',
      'stage4-plan': 'completed',
      'stage5-inspect': 'completed',
      'stage6-interact': 'completed',
    });

    // Stage 4: plan
    const plan = (await store.readArtifact(siteId, jobId, 'InspectionPlan', InspectionPlan)).data;
    expect(plan.strategy).toBe('representative');
    expect(plan.entries[0]?.url).toBe(`${site.baseUrl}/`);
    const planByUrl = Object.fromEntries(plan.entries.map((e) => [e.url, e]));
    expect(planByUrl[`${site.baseUrl}/login`]?.interactionsAllowed).toBe(false);
    expect(planByUrl[`${site.baseUrl}/spa`]).toMatchObject({ staticRenderMode: 'spa-shell' });
    expect(plan.entries.some((e) => e.templateKind === 'detail')).toBe(true);
    expect(plan.entries.length).toBeLessThanOrEqual(14);

    // Stage 5: page model
    const model = (await store.readArtifact(siteId, jobId, 'PageModel', PageModel)).data;
    const home = model.pages.find((p) => p.url === `${site.baseUrl}/`)!;
    expect(home.outcome).toBe('ok');
    expect(home.title).toBe('Fixture Shop');
    expect(home.dialogs.map((d) => d.kind)).toContain('consent');
    expect(home.regions.some((r) => r.role === 'navigation')).toBe(true);
    // The out-of-scope iframe document and the image (heavy resource) are refused at the network layer.
    expect(home.blockedRequests).toBeGreaterThanOrEqual(2);
    expect(home.ariaSnapshotExcerpt).toContain('search');
    expect(home.screenshot?.path).toMatch(/^blobs\/screenshots\//);
    await stat(join(result.jobDir, home.screenshot!.path));
    await stat(join(result.jobDir, home.domSnapshot!.path));
    const spa = model.pages.find((p) => p.url === `${site.baseUrl}/spa`)!;
    expect(spa.outcome).toBe('ok');
    expect(spa.hydration.delta).toBeGreaterThan(100);
    expect(spa.rendered.headings[0]?.text).toBe('Client rendered app');
    expect(model.stats.clientRenderedPages).toBeGreaterThanOrEqual(1);

    // Stage 5: element inventory
    const inv = (await store.readArtifact(siteId, jobId, 'ElementInventory', ElementInventory)).data;
    const homeElements = inv.elements.filter((e) => e.pageUrl === `${site.baseUrl}/`);
    const searchBox = homeElements.find((e) => e.kind === 'searchbox')!;
    expect(searchBox.category).toBe('search');
    expect(searchBox.locators[0]).toMatchObject({ strategy: 'testid', value: '[data-testid="search-input"]', unique: true });
    const searchForm = inv.forms.find((f) => f.pageUrl === `${site.baseUrl}/` && f.classification === 'search')!;
    expect(searchForm).toMatchObject({ method: 'get', sideEffectHint: 'read', hasSensitiveFields: false });
    expect(searchForm.fieldElementIds).toContain(searchBox.elementId);
    const accept = homeElements.find((e) => e.name === 'Accept all')!;
    expect(accept).toMatchObject({ inDialog: true, consequential: true });
    const loginElements = inv.elements.filter((e) => e.pageUrl === `${site.baseUrl}/login`);
    const signIn = loginElements.find((e) => e.kind === 'button' && e.name === 'Sign in')!;
    expect(signIn.category).toBe('authentication');
    expect(signIn.consequential).toBe(true);
    const loginForm = inv.forms.find((f) => f.pageUrl === `${site.baseUrl}/login` && f.method === 'post')!;
    expect(loginForm).toMatchObject({ classification: 'login', hasSensitiveFields: true, sideEffectHint: 'write' });
    expect(inv.stats.withUniqueLocator).toBeGreaterThan(inv.stats.elements * 0.5);
    const deepButtons = homeElements.filter((e) => e.kind === 'button' && e.text === '\u2795');
    expect(deepButtons).toHaveLength(2);
    // Semantic locators cannot tell the two apart; only a measured CSS path can, and it is marked unique only when it matched once.
    expect(deepButtons.every((e) => e.locators.filter((l) => l.strategy !== 'css-path').every((l) => !l.unique))).toBe(true);
    expect(deepButtons.every((e) => e.locators.filter((l) => l.strategy === 'css-path').every((l) => l.unique === (l.matches === 1)))).toBe(true);
    // The "Show more" button issues a POST from JavaScript; the probe may click it but the write is refused.
    expect(site.posts).toEqual([]);

    // Stage 6: probes
    const evidence = (await store.readArtifact(siteId, jobId, 'InteractionEvidence', InteractionEvidence)).data;
    const byKind = Object.fromEntries(evidence.probes.map((p) => [p.kind, p]));
    const onProducts = (kind: string) => evidence.probes.find((p) => p.kind === kind && p.pageUrl === `${site.baseUrl}/products`);
    expect(evidence.policy.allowWriteProbes).toBe(false);
    expect(byKind['form-submit-write']).toBeUndefined();
    expect(byKind['search-submit']).toMatchObject({ outcome: 'navigated', waitedFor: 'navigation' });
    expect(byKind['search-submit']!.after!.url).toContain('/search?q=');
    expect(byKind['menu-open']).toMatchObject({ outcome: 'changed' });
    expect(byKind['menu-open']!.changes?.targetStateAfter?.['aria-expanded']).toBe('true');
    expect(byKind['accordion-expand']).toMatchObject({ outcome: 'changed' });
    expect(byKind['accordion-expand']!.changes?.targetStateAfter?.['details-open']).toBe('true');
    expect(byKind['tab-change']).toMatchObject({ outcome: 'changed' });
    expect(byKind['tab-change']!.changes?.targetStateAfter?.['aria-selected']).toBe('true');
    expect(onProducts('pagination')).toMatchObject({ outcome: 'navigated' });
    expect(onProducts('pagination')!.after!.url).toContain('page=2');
    expect(onProducts('filter-change')).toMatchObject({ outcome: 'navigated' });
    expect(onProducts('filter-change')!.after!.url).toContain('sort=desc');
    // The header search form exists on every page but is probed once.
    expect(evidence.probes.filter((p) => p.kind === 'search-submit')).toHaveLength(1);
    expect(evidence.stats.deduplicated).toBeGreaterThanOrEqual(3);
    expect(evidence.probes.every((p) => p.restored)).toBe(true);
    expect(evidence.probes.every((p) => !p.pageUrl.includes('/login'))).toBe(true);
    expect(evidence.probes.length).toBeLessThanOrEqual(14);

    const log = await readFile(join(result.jobDir, evidence.evidenceLog), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(evidence.probes.length);

    const transitions = (await store.readArtifact(siteId, jobId, 'StateTransition', StateTransition)).data;
    expect(transitions.stats.navigations).toBeGreaterThanOrEqual(2);
    expect(transitions.stats.inPageChanges).toBeGreaterThanOrEqual(2);

    // The fixture never received a write, and robots-disallowed paths stayed untouched.
    expect(site.posts).toEqual([]);
    expect(site.requests.some((r) => r.startsWith('/private/'))).toBe(false);
  }, 180_000);

  it('submits a POST search form only when write probes are enabled', async () => {
    const run = (allowWriteProbes: boolean) =>
      discover({
        stages: PHASE2_STAGES,
        startUrl: `${site.baseUrl}/find-page`,
        outDir,
        allowPrivate: true,
        browser: { allowWriteProbes },
        budget: { maxPages: 2, maxDepth: 0, minDelayMs: 0, maxPagesToInspect: 1, maxProbesPerPage: 3, settleTimeoutMs: 800 },
        sleep: async () => {},
      });
    const before = site.posts.length;
    const off = await run(false);
    const offEvidence = (await off.store.readArtifact(off.siteId, off.jobId, 'InteractionEvidence', InteractionEvidence)).data;
    expect(offEvidence.probes.some((p) => p.kind === 'form-submit-write')).toBe(false);
    expect(site.posts.length).toBe(before);
    const on = await run(true);
    const onEvidence = (await on.store.readArtifact(on.siteId, on.jobId, 'InteractionEvidence', InteractionEvidence)).data;
    const write = onEvidence.probes.find((p) => p.kind === 'form-submit-write');
    expect(write).toMatchObject({ outcome: 'navigated' });
    expect(site.posts).toContain('/find');
  }, 90_000);

  it('skips probes when interactions are disabled', async () => {
    const result = await discover({
      stages: PHASE2_STAGES,
      startUrl: `${site.baseUrl}/about`,
      outDir,
      allowPrivate: true,
      browser: { interactions: false },
      budget: { maxPages: 3, maxDepth: 0, minDelayMs: 0, maxPagesToInspect: 1, settleTimeoutMs: 800 },
      sleep: async () => {},
    });
    const evidence = (await result.store.readArtifact(result.siteId, result.jobId, 'InteractionEvidence', InteractionEvidence)).data;
    expect(evidence.probes).toEqual([]);
    expect(evidence.stats.executed).toBe(0);
  }, 60_000);
});
