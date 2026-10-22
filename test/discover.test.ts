import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, PHASE1_STAGES } from '../src/index.js';
import { stage0Scope } from '../src/stages/stage0-scope.js';
import { stage1Docs } from '../src/stages/stage1-docs.js';
import { stage2Sitemap } from '../src/stages/stage2-sitemap.js';
import { stage3Crawl } from '../src/stages/stage3-crawl.js';
import { ArtifactExistsError, StageFailedError } from '../src/core/errors.js';
import { CrawlReport, PageInventory, PageTemplates, SiteManifest, URLInventory } from '../src/schemas/index.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-test-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('discover (phase 1 pipeline)', () => {
  it('runs scope, sitemap and crawl stages end to end against the fixture site', async () => {
    const result = await discover({
      stages: PHASE1_STAGES,
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      budget: { maxPages: 48, maxDepth: 3, minDelayMs: 0, maxResponseBytes: 200_000, maxConcurrency: 3, maxRetries: 2 },
      sleep: async () => {},
    });
    const { store, siteId, jobId, job } = result;

    expect(job.status).toBe('completed');
    expect(job.stages.map((s) => s.status)).toEqual(['completed', 'completed', 'completed']);

    // Stage 0
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    expect(manifest.data.scope.allowedHosts).toContain('127.0.0.1');
    expect(manifest.data.scope.allowPrivateNetwork).toBe(true);
    expect(manifest.data.resolvedAddresses).toEqual(['127.0.0.1']);

    // Stage 2
    const inventory = await store.readArtifact(siteId, jobId, 'URLInventory', URLInventory);
    expect(inventory.data.robots.status).toBe('found');
    expect(inventory.data.robots.sitemaps).toEqual([`${site.baseUrl}/sitemap_index.xml`]);
    const okSitemaps = inventory.data.sitemaps.filter((s) => s.status === 'ok');
    expect(okSitemaps.map((s) => s.kind).sort()).toEqual(['index', 'urlset', 'urlset']);
    const product1 = inventory.data.urls.find((u) => u.url === `${site.baseUrl}/products/1`);
    expect(product1).toMatchObject({ inScope: true, priority: 0.8, lastmod: '2026-10-01', changefreq: 'weekly', robotsAllowed: true });
    expect(inventory.data.urls.find((u) => u.url === `${site.baseUrl}/private/secret`)?.robotsAllowed).toBe(false);
    expect(inventory.data.urls.find((u) => u.url === 'https://external.example/out')?.inScope).toBe(false);
    expect(inventory.data.stats.fromSitemap).toBe(16);
    expect(inventory.data.routeCandidates[0]).toMatchObject({ pattern: '/products/{id}', count: 6 });

    // Stage 3: page inventory
    const pages = (await store.readArtifact(siteId, jobId, 'PageInventory', PageInventory)).data.pages;
    const byUrl = (path: string) => pages.find((p) => p.requestedUrl === `${site.baseUrl}${path}`);
    expect(byUrl('/')?.outcome).toBe('ok');
    expect(byUrl('/')?.html?.title).toBe('Fixture Shop');
    expect(byUrl('/')?.html?.forms[0]?.classification).toBe('search');
    expect(byUrl('/redirect-out')).toMatchObject({ outcome: 'redirected-out-of-scope', finalUrl: 'https://external.example/landing' });
    expect(byUrl('/redirect-in')).toMatchObject({ outcome: 'ok', finalUrl: `${site.baseUrl}/about` });
    expect(byUrl('/image.png')?.outcome).toBe('non-html');
    expect(byUrl('/blocked')).toMatchObject({ outcome: 'blocked', blockedSignal: 'cloudflare-challenge' });
    expect(byUrl('/big')?.outcome).toBe('too-large');
    expect(byUrl('/loop1')?.outcome).toBe('network-error');
    expect(byUrl('/spa')?.html?.renderMode.kind).toBe('spa-shell');
    expect(byUrl('/retry')?.outcome).toBe('ok');
    expect(byUrl('/strict/')).toMatchObject({ outcome: 'ok', finalUrl: `${site.baseUrl}/strict/` });
    expect(byUrl('/latin1')?.html?.title).toBe('Café Menü');
    expect(byUrl('/products/1')?.html?.jsonLdTypes).toEqual(['Product']);
    expect(byUrl('/private/secret')).toBeUndefined();
    expect(byUrl('/about?utm_source=nav&utm_medium=header')).toBeUndefined();
    expect(pages.filter((p) => p.requestedUrl.startsWith(`${site.baseUrl}/about`))).toHaveLength(1);

    // The crawler never touched robots-disallowed or out-of-scope targets.
    expect(site.requests.some((r) => r.startsWith('/private/'))).toBe(false);
    expect(site.requests.some((r) => r.includes('external.example'))).toBe(false);
    expect(pages.length).toBeLessThanOrEqual(48);

    // Stage 3: templates
    const templates = (await store.readArtifact(siteId, jobId, 'PageTemplates', PageTemplates)).data.templates;
    const byPattern = Object.fromEntries(templates.map((t) => [t.urlPattern, t]));
    expect(byPattern['/']).toMatchObject({ kind: 'home', pageCount: 1 });
    expect(byPattern['/products/{id}']).toMatchObject({ kind: 'detail', pageCount: 6, cohesion: 1 });
    expect(byPattern['/products/{id}']!.representativeUrls.length).toBeLessThanOrEqual(3);
    expect(byPattern['/docs/{slug}']).toMatchObject({ kind: 'documentation', pageCount: 4 });
    expect(byPattern['/blog/{slug}']).toMatchObject({ kind: 'article', pageCount: 2 });
    expect(byPattern['/login']?.kind).toBe('auth');
    expect(byPattern['/search?q']?.kind).toBe('search');
    expect(byPattern['/products']?.kind).toBe('listing');
    expect(byPattern['/products?page']?.kind).toBe('listing');
    expect(byPattern['/contact']?.kind).toBe('form');
    expect(byPattern['/privacy']?.kind).toBe('legal');

    // Stage 3: report
    const report = (await store.readArtifact(siteId, jobId, 'CrawlReport', CrawlReport)).data;
    expect(report.siteBlocked).toBe(false);
    expect(report.siteRenderMode).toBe('static');
    expect(report.blockedSignals).toEqual([{ url: `${site.baseUrl}/blocked`, signal: 'cloudflare-challenge' }]);
    expect(report.counts['ok']).toBeGreaterThanOrEqual(15);
    expect(report.budget.pagesAttempted).toBe(pages.length);
    expect(report.renderModes['spa-shell']).toBe(1);

    // Artifacts are immutable.
    await expect(store.writeArtifact(manifest)).rejects.toBeInstanceOf(ArtifactExistsError);
  }, 60_000);

  it('rejects private targets unless explicitly allowed', async () => {
    await expect(discover({ stages: PHASE1_STAGES, startUrl: `${site.baseUrl}/`, outDir, allowPrivate: false, sleep: async () => {} })).rejects.toBeInstanceOf(StageFailedError);
  });

  it('rejects non-http schemes before any request is made', async () => {
    const before = site.requests.length;
    await expect(discover({ stages: PHASE1_STAGES, startUrl: 'file:///etc/passwd', outDir, allowPrivate: true })).rejects.toThrow();
    expect(site.requests.length).toBe(before);
  });

  it('shares the sitemap URL budget across child sitemaps instead of filling it from the first one', async () => {
    const result = await discover({
      stages: PHASE1_STAGES,
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      budget: { maxPages: 2, maxDepth: 1, minDelayMs: 0, maxSitemapUrls: 4 },
      sleep: async () => {},
    });
    const inventory = await result.store.readArtifact(result.siteId, result.jobId, 'URLInventory', URLInventory);
    const fromSitemap = inventory.data.urls.filter((u) => u.sources.some((s) => s.kind === 'sitemap'));
    const origins = new Set(fromSitemap.flatMap((u) => u.sources.filter((s) => s.kind === 'sitemap').map((s) => s.from)));
    expect(fromSitemap.length).toBe(4);
    expect(origins).toEqual(new Set([`${site.baseUrl}/sitemap-pages.xml`, `${site.baseUrl}/sitemap-products.xml.gz`]));
    expect(inventory.data.stats.truncated).toBe(true);
  });

  it('seeds the crawl with llms.txt links ahead of sitemap URLs', async () => {
    const result = await discover({
      stages: [stage0Scope, stage1Docs, stage2Sitemap, stage3Crawl],
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      budget: { maxPages: 3, maxDepth: 1, minDelayMs: 0 },
      sleep: async () => {},
    });
    const pages = (await result.store.readArtifact(result.siteId, result.jobId, 'PageInventory', PageInventory)).data.pages;
    const viaDocs = pages.filter((p) => p.discoveredVia === 'docs').map((p) => new URL(p.finalUrl).pathname);
    expect(viaDocs.length).toBe(2);
    expect(new Set(viaDocs)).toEqual(new Set(['/docs/intro', '/products']));
  });

  it('honors the page budget and reports the remaining frontier', async () => {
    const result = await discover({
      stages: PHASE1_STAGES,
      startUrl: `${site.baseUrl}/`,
      outDir,
      allowPrivate: true,
      budget: { maxPages: 5, maxDepth: 2, minDelayMs: 0, maxConcurrency: 1 },
      sleep: async () => {},
    });
    const report = (await result.store.readArtifact(result.siteId, result.jobId, 'CrawlReport', CrawlReport)).data;
    expect(report.budget.pagesAttempted).toBe(5);
    expect(report.budget.frontierRemaining).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('page budget'))).toBe(true);
  });

  it('marks a site as blocked when every page is a challenge', async () => {
    const blocked = await startFixtureSite({ blockAll: true });
    try {
      const result = await discover({
        startUrl: `${blocked.baseUrl}/`,
        outDir,
        allowPrivate: true,
        budget: { maxPages: 6, maxDepth: 1, minDelayMs: 0, maxRetries: 0 },
        sleep: async () => {},
      });
      const report = (await result.store.readArtifact(result.siteId, result.jobId, 'CrawlReport', CrawlReport)).data;
      expect(report.siteBlocked).toBe(true);
      expect(report.counts['blocked']).toBeGreaterThan(0);
      expect(report.counts['ok'] ?? 0).toBe(0);
      expect(report.warnings.some((w) => w.includes('does not attempt to evade'))).toBe(true);
    } finally {
      await blocked.close();
    }
  });
});
