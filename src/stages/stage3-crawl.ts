import { parseRobots, type RobotsRules } from '../net/robots.js';
import type { StageDefinition } from '../core/job.js';
import type { FetchOutcome } from '../net/http.js';
import { normalizeUrl, hostnameOf, FETCH_NORMALIZE } from '../net/url.js';
import { decodeHtml } from '../html/charset.js';
import { extractHtmlFacts } from '../html/extract.js';
import { detectBlockSignal } from '../html/blocked.js';
import { buildFamilyIndex, buildTemplates } from '../html/templates.js';
import type { UrlSourceKind } from '../schemas/common.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { URLInventory } from '../schemas/urlInventory.js';
import { PageInventory, PAGE_INVENTORY_VERSION, type PageInventoryData, type PageOutcome, type PageRecord, type RenderModeKind } from '../schemas/pageInventory.js';
import { PageTemplates, PAGE_TEMPLATES_VERSION, type PageTemplatesData } from '../schemas/pageTemplates.js';
import { CrawlReport, CRAWL_REPORT_VERSION, type CrawlReportData } from '../schemas/crawlReport.js';
import { DocumentationIndex } from '../schemas/documentationIndex.js';
import { createHttpClient, makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

const HTML_TYPES = /text\/html|application\/xhtml\+xml/i;
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.3';

interface FrontierItem {
  /** Normalized URL: the deduplication key. */
  url: string;
  /** URL to request, as the site published it. */
  fetchUrl: string;
  depth: number;
  via: UrlSourceKind;
  from?: string;
  /** Lower runs first. Links from pages beat sitemap seeds at equal depth. */
  rank: number;
}

/**
 * Coarse URL shape used to spread a small page budget across a site's sections:
 * path depth plus the leading literal segment (two when the first is a locale),
 * so /en/autos/bmw, /en/autos/toyota/corolla and /en/cardetail/x are three shapes.
 */
export function urlShape(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return url;
  }
  const locale = /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[0] ?? '') ? segments[0]!.toLowerCase() : undefined;
  const rest = locale ? segments.slice(1) : segments;
  // Top-level pages (/about, /compare, /en/faq) are one shape: each is a one-off, and a small budget
  // must not be spent visiting every one of them before any deeper section.
  const head = rest.length <= 1 ? '*' : rest[0]!.toLowerCase();
  return `${segments.length}:${locale ? `${locale}/` : ''}${head}`;
}

/** Interleave items so consecutive picks come from different URL shapes. */
export function interleaveByShape<T>(items: T[], urlOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = urlShape(urlOf(item));
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const out: T[] = [];
  const queues = Array.from(groups.values());
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}

class Frontier {
  private readonly buckets = new Map<number, FrontierItem[]>();
  private readonly known = new Set<string>();
  /** How many pages of each URL shape have been handed out; pops favour the least-visited shape. */
  private readonly popped = new Map<string, number>();
  private _size = 0;

  /**
   * @param maxSize frontier capacity
   * @param shapeQuota pages a URL shape may take before shapes with fewer pages are preferred, whatever
   *   their rank: a 30-page budget then samples fifteen sections twice instead of one section thirty times.
   */
  constructor(
    private readonly maxSize: number,
    private readonly shapeQuota = 2,
  ) {}

  has(url: string): boolean {
    return this.known.has(url);
  }

  /** Returns false when the frontier is full or the URL is already known. */
  push(item: FrontierItem): boolean {
    if (this.known.has(item.url)) return false;
    if (this._size >= this.maxSize) return false;
    this.known.add(item.url);
    const bucket = this.buckets.get(item.rank) ?? [];
    bucket.push(item);
    this.buckets.set(item.rank, bucket);
    this._size += 1;
    return true;
  }

  pop(): FrontierItem | undefined {
    // Order: shapes that have used up fewer quotas first, then rank, then insertion order.
    const ranks = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    let best: { rank: number; index: number; tier: number } | undefined;
    for (const rank of ranks) {
      const bucket = this.buckets.get(rank)!;
      if (bucket.length === 0) {
        this.buckets.delete(rank);
        continue;
      }
      for (let i = 0; i < bucket.length; i += 1) {
        const tier = Math.floor((this.popped.get(urlShape(bucket[i]!.url)) ?? 0) / this.shapeQuota);
        if (!best || tier < best.tier) best = { rank, index: i, tier };
        if (tier === 0) break;
      }
      if (best?.tier === 0) break;
    }
    if (!best) return undefined;
    const bucket = this.buckets.get(best.rank)!;
    const [item] = bucket.splice(best.index, 1);
    if (bucket.length === 0) this.buckets.delete(best.rank);
    if (!item) return undefined;
    const shape = urlShape(item.url);
    this.popped.set(shape, (this.popped.get(shape) ?? 0) + 1);
    this._size -= 1;
    return item;
  }

  get size(): number {
    return this._size;
  }
}

/**
 * Stage 3: breadth-first static crawl of in-scope pages, HTML fact extraction,
 * template grouping and a crawl report. Launches no browser.
 */
export const stage3Crawl: StageDefinition<DiscoveryInput> = {
  id: 'stage3-crawl',
  produces: ['PageInventory', 'PageTemplates', 'CrawlReport'],
  requires: ['stage0-scope', 'stage2-sitemap'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const inventory = await ctx.artifact('URLInventory', URLInventory);
    const { budget, scope: scopeData } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const http = createHttpClient(manifest.data, ctx.input);
    const startedAt = ctx.now();

    // Robots verdicts for link-discovered URLs: re-fetching robots.txt is cheap and keeps stages independent.
    let robots: RobotsRules | undefined;
    if (scopeData.respectRobots && inventory.data.robots.status === 'found') {
      const res = await http.fetch(inventory.data.robots.url, { accept: 'text/plain,*/*;q=0.5', acceptTypes: /text\/|octet-stream/i });
      if (res.ok && res.status === 200 && !res.bodySkipped) robots = parseRobots(inventory.data.robots.url, res.body.toString('utf8'));
    }
    const robotsAllows = (url: string): boolean => {
      if (!scopeData.respectRobots || !robots) return true;
      const verdict = robots.isAllowed(url, scopeData.userAgent);
      return verdict === undefined ? true : verdict;
    };

    const frontier = new Frontier(Math.max(budget.maxPages * 10, 1000), Math.max(2, Math.floor(budget.maxPages / 15)));
    const pages: PageRecord[] = [];
    const counts: Record<string, number> = {};
    const statusHistogram: Record<string, number> = {};
    const blockedSignals: CrawlReportData['blockedSignals'] = [];
    const warnings: string[] = [];
    let robotsSkipped = 0;
    let attempted = 0;
    let budgetExhausted = false;

    const bump = (table: Record<string, number>, key: string) => {
      table[key] = (table[key] ?? 0) + 1;
    };

    frontier.push({ url: normalizeUrl(manifest.data.normalizedStartUrl) ?? manifest.data.normalizedStartUrl, fetchUrl: manifest.data.normalizedStartUrl, depth: 0, via: 'start', rank: 0 });
    // Pages the site itself points agents at (llms.txt) come right after the start URL, before homepage links.
    let docsSeeded = 0;
    if (await ctx.hasArtifact('DocumentationIndex')) {
      const docs = await ctx.artifact('DocumentationIndex', DocumentationIndex);
      for (const section of docs.data.llms?.sections ?? []) {
        for (const link of section.links) {
          const normalized = normalizeUrl(link.url);
          if (!normalized || !scope.isInScope(normalized)) continue;
          // Machine-readable files (specs, feeds, markdown) belong to the docs stage, not the HTML crawl.
          if (/\.(json|ya?ml|xml|txt|md|markdown|pdf|csv|rss|atom)$/i.test(new URL(normalized).pathname)) continue;
          if (frontier.push({ url: normalized, fetchUrl: normalizeUrl(link.url, undefined, FETCH_NORMALIZE) ?? link.url, depth: 1, via: 'docs', from: docs.data.llms!.url, rank: 5 })) docsSeeded += 1;
        }
      }
    }
    // Sitemap seeds are interleaved by URL shape so a frontier capped below the inventory size
    // still holds every section of the site, not just the alphabetically first one.
    const sitemapSeeds = interleaveByShape(
      inventory.data.urls
        .filter((u) => u.inScope && u.sources.some((s) => s.kind === 'sitemap'))
        .sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5) || pathDepth(a.url) - pathDepth(b.url) || a.url.localeCompare(b.url)),
      (u) => u.url,
    );
    for (const seed of sitemapSeeds) {
      if (seed.robotsAllowed === false) {
        robotsSkipped += 1;
        continue;
      }
      const published = seed.sources.find((s) => s.kind === 'sitemap' && s.observedUrl)?.observedUrl;
      frontier.push({ url: seed.url, fetchUrl: (published && normalizeUrl(published, undefined, FETCH_NORMALIZE)) || seed.url, depth: 1, via: 'sitemap', rank: 15 });
    }

    const processOne = async (item: FrontierItem): Promise<void> => {
      if (!robotsAllows(item.url)) {
        robotsSkipped += 1;
        bump(counts, 'robots-disallowed');
        return;
      }
      attempted += 1;
      const fetchedAt = ctx.now().toISOString();
      const outcome = await http.fetch(item.fetchUrl, { accept: HTML_ACCEPT, acceptTypes: HTML_TYPES, signal: ctx.signal });
      const record = toPageRecord(item, outcome, fetchedAt);

      if (record.outcome === 'budget-exhausted') budgetExhausted = true;
      if (outcome.ok) bump(statusHistogram, String(outcome.status));
      bump(counts, record.outcome);
      if (record.blockedSignal) blockedSignals.push({ url: item.url, signal: record.blockedSignal });

      if (outcome.ok && record.outcome === 'ok' && !outcome.bodySkipped) {
        const { text: html } = decodeHtml(outcome.body, outcome.contentType);
        record.html = extractHtmlFacts(html, { finalUrl: outcome.finalUrl, scope, maxLinks: budget.maxLinksPerPage });
        if (item.depth < budget.maxDepth) {
          for (const link of record.html.links) {
            if (!link.inScope || frontier.has(link.href) || seen.has(link.href)) continue;
            frontier.push({ url: link.href, fetchUrl: link.observed ?? link.href, depth: item.depth + 1, via: 'link', from: outcome.finalUrl, rank: (item.depth + 1) * 10 });
          }
        }
        if (record.html.canonical && scope.isInScope(record.html.canonical) && !seen.has(record.html.canonical)) {
          frontier.push({ url: record.html.canonical, fetchUrl: record.html.canonical, depth: item.depth, via: 'canonical', from: outcome.finalUrl, rank: item.depth * 10 + 1 });
        }
      }
      pages.push(record);
      ctx.logger.debug(`${record.outcome} ${record.status ?? ''} ${item.url} (depth ${item.depth})`);
    };

    const seen = new Set<string>();
    let inflight = 0;
    try {
      // Worker pool bounded by maxConcurrency; the HTTP client also enforces it, but
      // this keeps the frontier ordering meaningful.
      const workers = Array.from({ length: budget.maxConcurrency }, async () => {
        for (;;) {
          if (ctx.signal.aborted || budgetExhausted) return;
          if (attempted + inflight >= budget.maxPages) return;
          const item = frontier.pop();
          if (!item) {
            if (inflight === 0) return;
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          inflight += 1;
          try {
            await processOne(item);
          } finally {
            inflight -= 1;
          }
        }
      });
      await Promise.all(workers);
    } finally {
      await http.close();
    }

    if (budgetExhausted) warnings.push('request budget exhausted before the frontier was empty');
    if (frontier.size > 0 && attempted >= budget.maxPages) warnings.push(`page budget reached with ${frontier.size} in-scope URLs left unfetched`);
    const okPages = pages.filter((p) => p.outcome === 'ok');
    const blockedCount = counts['blocked'] ?? 0;
    const siteBlocked = okPages.length === 0 && blockedCount > 0;
    if (siteBlocked) warnings.push('every fetched page was a bot-protection or rate-limit response; WebMorph does not attempt to evade these');
    else if (blockedCount >= 3) warnings.push(`${blockedCount} blocked responses observed`);

    const renderModes: Record<string, number> = {};
    for (const p of okPages) bump(renderModes, p.html!.renderMode.kind);
    const siteRenderMode = dominantRenderMode(renderModes);
    if (siteRenderMode === 'spa-shell') warnings.push('site renders client-side; static HTML carries little evidence and later stages should go browser-first');

    const byDepth: Record<string, number> = {};
    for (const p of pages) bump(byDepth, String(p.depth));

    // Sitemap URLs prove which path families exist even when only a couple of their members were fetched.
    const templates = buildTemplates(pages, { familySize: buildFamilyIndex(inventory.data.urls.filter((u) => u.inScope).map((u) => u.url)) });
    const lowCohesion = templates.filter((t) => t.pageCount >= 3 && t.cohesion < 0.5).length;

    const pageInventoryData: PageInventoryData = {
      pages,
      stats: { attempted, ok: okPages.length, byOutcome: counts },
    };
    const templatesData: PageTemplatesData = {
      templates,
      stats: { pagesGrouped: okPages.length, templateCount: templates.length, lowCohesionTemplates: lowCohesion },
    };
    const finishedAt = ctx.now();
    const reportData: CrawlReportData = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      budget: {
        maxPages: budget.maxPages,
        pagesAttempted: attempted,
        maxRequests: budget.maxRequests,
        requestsMade: http.requestsMade,
        maxDepth: budget.maxDepth,
        deepestDepth: pages.reduce((m, p) => Math.max(m, p.depth), 0),
        frontierRemaining: frontier.size,
      },
      counts: { ...counts, 'robots-disallowed': robotsSkipped },
      statusHistogram,
      byDepth,
      renderModes: renderModes as CrawlReportData['renderModes'],
      blockedSignals,
      siteBlocked,
      siteRenderMode,
      warnings,
    };

    const sources = [refTo(manifest), refTo(inventory)];
    const common = { siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage3-crawl' as const, sources, now: ctx.now };
    const pageInventory = PageInventory.parse({ ...makeEnvelope({ ...common, type: 'PageInventory', schemaVersion: PAGE_INVENTORY_VERSION }), data: pageInventoryData });
    const pageTemplates = PageTemplates.parse({
      ...makeEnvelope({ ...common, type: 'PageTemplates', schemaVersion: PAGE_TEMPLATES_VERSION, sources: [...sources, refTo(pageInventory)] }),
      data: templatesData,
    });
    const crawlReport = CrawlReport.parse({
      ...makeEnvelope({ ...common, type: 'CrawlReport', schemaVersion: CRAWL_REPORT_VERSION, sources: [...sources, refTo(pageInventory)] }),
      data: reportData,
    });
    ctx.logger.info(`crawl: ${attempted} fetched, ${okPages.length} ok, ${templates.length} templates, render mode ${siteRenderMode}${docsSeeded ? `, ${docsSeeded} llms.txt seed(s)` : ''}`);
    return [pageInventory, pageTemplates, crawlReport];
  },
};

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

function dominantRenderMode(table: Record<string, number>): RenderModeKind {
  const entries = Object.entries(table).sort((a, b) => b[1] - a[1]);
  const top = entries[0]?.[0] as RenderModeKind | undefined;
  return top ?? 'static';
}

function toPageRecord(item: FrontierItem, outcome: FetchOutcome, fetchedAt: string): PageRecord {
  const base = {
    requestedUrl: item.fetchUrl,
    depth: item.depth,
    discoveredVia: item.via,
    fetchedAt,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
  };

  if (!outcome.ok) {
    const lastHop = outcome.redirectChain[outcome.redirectChain.length - 1];
    const map: Record<typeof outcome.kind, PageOutcome> = {
      'out-of-scope': outcome.redirectChain.length > 0 ? 'redirected-out-of-scope' : 'prohibited',
      'ssrf-blocked': 'network-error',
      'too-many-redirects': 'network-error',
      timeout: 'network-error',
      network: 'network-error',
      'too-large': 'too-large',
      'budget-exhausted': 'budget-exhausted',
      prohibited: 'prohibited',
    };
    return {
      ...base,
      finalUrl: outcome.refusedUrl ?? lastHop?.url ?? item.fetchUrl,
      redirectChain: outcome.redirectChain,
      status: lastHop?.status,
      outcome: map[outcome.kind],
      error: outcome.message,
    };
  }

  const contentType = outcome.contentType;
  const bodyText = outcome.bodySkipped ? '' : outcome.body.toString('utf8', 0, Math.min(outcome.body.length, 20_000));
  const signal = detectBlockSignal(outcome.status, outcome.headers, bodyText);
  let pageOutcome: PageOutcome;
  if (signal && (outcome.status >= 400 || /challenge|captcha|datadome|perimeterx|distil/.test(signal))) pageOutcome = 'blocked';
  else if (outcome.status >= 400) pageOutcome = 'http-error';
  else if (outcome.bodySkipped || !contentType || !HTML_TYPES.test(contentType)) pageOutcome = 'non-html';
  else pageOutcome = 'ok';

  return {
    ...base,
    finalUrl: outcome.finalUrl,
    redirectChain: outcome.redirectChain,
    status: outcome.status,
    contentType,
    outcome: pageOutcome,
    ...(signal && pageOutcome === 'blocked' ? { blockedSignal: signal } : {}),
    ...(pageOutcome === 'http-error' ? { error: `HTTP ${outcome.status}` } : {}),
  };
}

export const __test = { Frontier, toPageRecord, normalizeUrl, hostnameOf };
