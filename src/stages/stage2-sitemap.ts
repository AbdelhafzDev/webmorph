import { parseRobots, type RobotsRules } from '../net/robots.js';
import { XMLParser } from 'fast-xml-parser';
import type { StageDefinition } from '../core/job.js';
import { normalizeUrl, sameSite, hostnameOf } from '../net/url.js';
import { ScopePolicy } from '../net/scope.js';
import { SafeHttpClient } from '../net/http.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { URLInventory, URL_INVENTORY_VERSION, type RouteCandidate, type SitemapRecord, type UrlEntry, type URLInventoryData } from '../schemas/urlInventory.js';
import { urlPattern } from '../html/templates.js';
import { createHttpClient, makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

const CONVENTIONAL_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml', '/wp-sitemap.xml', '/sitemap.txt'];
const SITEMAP_ACCEPT = 'application/xml,text/xml,text/plain,application/gzip;q=0.9,*/*;q=0.5';
const SITEMAP_TYPES = /xml|text\/plain|gzip|octet-stream|html/i;

interface ParsedSitemap {
  kind: SitemapRecord['kind'];
  children: string[];
  urls: Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number }>;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  cdataPropName: '__cdata',
  isArray: (name) => name === 'sitemap' || name === 'url',
});

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['__cdata'] === 'string') return obj['__cdata'].trim() || undefined;
    if (typeof obj['#text'] === 'string') return obj['#text'].trim() || undefined;
  }
  return undefined;
}

export function parseSitemap(body: string, contentType: string | undefined): ParsedSitemap {
  const trimmed = body.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('<')) {
    const doc = xml.parse(trimmed) as Record<string, unknown>;
    const index = doc['sitemapindex'] as Record<string, unknown> | undefined;
    if (index) {
      const entries = (index['sitemap'] as Array<Record<string, unknown>> | undefined) ?? [];
      const children = entries.map((e) => textOf(e['loc'])).filter((x): x is string => Boolean(x));
      return { kind: 'index', children, urls: [] };
    }
    const urlset = doc['urlset'] as Record<string, unknown> | undefined;
    if (urlset) {
      const entries = (urlset['url'] as Array<Record<string, unknown>> | undefined) ?? [];
      const urls = entries
        .map((e) => {
          const loc = textOf(e['loc']);
          if (!loc) return null;
          const priorityRaw = textOf(e['priority']);
          const priority = priorityRaw !== undefined ? Number(priorityRaw) : undefined;
          return {
            loc,
            lastmod: textOf(e['lastmod']),
            changefreq: textOf(e['changefreq']),
            priority: priority !== undefined && Number.isFinite(priority) ? priority : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return { kind: 'urlset', children: [], urls };
    }
    return { kind: 'unknown', children: [], urls: [] };
  }
  if (!contentType || /text\/plain|octet-stream|gzip/i.test(contentType) || /^https?:\/\//m.test(trimmed)) {
    const urls = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
      .map((loc) => ({ loc }));
    return { kind: 'text', children: [], urls };
  }
  return { kind: 'unknown', children: [], urls: [] };
}

/**
 * Stage 2: robots.txt, sitemap discovery and the first URL inventory.
 * A sitemap is a hint, not proof a page exists; Stage 3 verifies.
 */
export const stage2Sitemap: StageDefinition<DiscoveryInput> = {
  id: 'stage2-sitemap',
  produces: ['URLInventory'],
  requires: ['stage0-scope'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const { scope: scopeData, budget } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const http = createHttpClient(manifest.data, ctx.input);
    const origin = scopeData.origin;
    // Sitemap files often live on a sibling host (sitemaps.example.com, a CDN). Fetch those too; the URLs they list are still scope-checked.
    const sitemapHosts = new Set<string>();
    let sitemapHttp: SafeHttpClient | undefined;
    const clientFor = (url: string): SafeHttpClient => {
      const host = hostnameOf(url);
      if (scope.isHostAllowed(host)) return http;
      if (!sitemapHosts.has(host)) {
        sitemapHosts.add(host);
        void sitemapHttp?.close();
        sitemapHttp = new SafeHttpClient({
          scope: new ScopePolicy({ ...scopeData, allowedHosts: [...scopeData.allowedHosts, ...sitemapHosts] }, { hosts: manifest.data.prohibited.hosts, pathPatterns: manifest.data.prohibited.pathPatterns }),
          allowPrivate: scopeData.allowPrivateNetwork,
          userAgent: scopeData.userAgent,
          requestTimeoutMs: budget.requestTimeoutMs,
          maxResponseBytes: budget.maxResponseBytes,
          maxRedirects: budget.maxRedirects,
          maxRetries: budget.maxRetries,
          minDelayMs: budget.minDelayMs,
          maxConcurrency: budget.maxConcurrency,
          maxRequests: budget.maxSitemaps * 2,
          resolver: ctx.input.resolver,
          sleep: ctx.input.sleep,
        });
      }
      return sitemapHttp!;
    };
    const sitemapHostOk = (url: string): boolean => scope.isInScope(url) || (/^https?:/.test(url) && sameSite(hostnameOf(url), hostnameOf(origin)));

    try {
      // robots.txt
      const robotsUrl = `${origin}/robots.txt`;
      const robotsResult: URLInventoryData['robots'] = { url: robotsUrl, status: 'missing', sitemaps: [] };
      let robots: RobotsRules | undefined;
      const robotsFetch = await http.fetch(robotsUrl, { accept: 'text/plain,*/*;q=0.5', acceptTypes: /text\/|octet-stream/i });
      if (robotsFetch.ok && robotsFetch.status === 200 && !robotsFetch.bodySkipped) {
        robots = parseRobots(robotsUrl, robotsFetch.body.toString('utf8'));
        robotsResult.status = 'found';
        robotsResult.sitemaps = robots
          .getSitemaps()
          .map((s) => normalizeUrl(s, origin, { keepQuery: true }))
          .filter((s): s is string => Boolean(s));
        ctx.logger.info(`robots.txt found, ${robotsResult.sitemaps.length} sitemap(s) declared`);
      } else if (robotsFetch.ok && robotsFetch.status === 404) {
        ctx.logger.info('robots.txt missing');
      } else {
        robotsResult.status = robotsFetch.ok ? 'missing' : 'error';
        robotsResult.error = robotsFetch.ok ? `HTTP ${robotsFetch.status}` : robotsFetch.message;
        ctx.logger.warn(`robots.txt: ${robotsResult.error}`);
      }

      const robotsAllowed = (url: string): boolean | undefined => {
        if (!robots) return undefined;
        const verdict = robots.isAllowed(url, scopeData.userAgent);
        return verdict === undefined ? true : verdict;
      };

      // Sitemap candidates
      const candidates: string[] = [];
      const seenCandidates = new Set<string>();
      const pushCandidate = (u: string | null) => {
        if (u && !seenCandidates.has(u) && sitemapHostOk(u)) {
          seenCandidates.add(u);
          candidates.push(u);
        }
      };
      for (const s of robotsResult.sitemaps) pushCandidate(s);
      if (candidates.length === 0) for (const path of CONVENTIONAL_SITEMAPS) pushCandidate(normalizeUrl(origin + path));

      const urls = new Map<string, UrlEntry>();
      const addUrl = (loc: string, source: UrlEntry['sources'][number], meta: Partial<UrlEntry> = {}) => {
        const normalized = normalizeUrl(loc);
        if (!normalized) return;
        const existing = urls.get(normalized);
        const src = { ...source, ...(normalized !== loc ? { observedUrl: loc } : {}) };
        if (existing) {
          existing.sources.push(src);
          if (meta.lastmod && !existing.lastmod) existing.lastmod = meta.lastmod;
          if (meta.priority !== undefined && existing.priority === undefined) existing.priority = meta.priority;
          if (meta.changefreq && !existing.changefreq) existing.changefreq = meta.changefreq;
          return;
        }
        const inScope = scope.isInScope(normalized);
        urls.set(normalized, {
          url: normalized,
          sources: [src],
          inScope,
          robotsAllowed: inScope ? robotsAllowed(normalized) : undefined,
          ...(meta.lastmod ? { lastmod: meta.lastmod } : {}),
          ...(meta.changefreq ? { changefreq: meta.changefreq } : {}),
          ...(meta.priority !== undefined ? { priority: meta.priority } : {}),
        });
      };

      addUrl(manifest.data.normalizedStartUrl, { kind: 'start' });

      const sitemapRecords: SitemapRecord[] = [];
      const queue: Array<{ url: string; depth: number; declared: boolean }> = candidates.map((url) => ({ url, depth: 0, declared: robotsResult.sitemaps.includes(url) }));
      const visited = new Set<string>();
      let fetched = 0;
      let truncated = false;
      // URLs are buffered per sitemap and admitted round-robin afterwards, so a site whose first
      // child sitemap alone exceeds the budget (every make/model page) still contributes its other
      // sections (detail pages, cities, static pages) to the inventory.
      const buffers: Array<{ from: string; entries: ParsedSitemap['urls'] }> = [];

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        if (fetched >= budget.maxSitemaps) {
          sitemapRecords.push({ url: item.url, status: 'skipped', urlCount: 0, depth: item.depth, error: 'maxSitemaps reached' });
          truncated = true;
          continue;
        }
        fetched += 1;
        const res = await clientFor(item.url).fetch(item.url, { accept: SITEMAP_ACCEPT, acceptTypes: SITEMAP_TYPES });
        if (!res.ok) {
          sitemapRecords.push({ url: item.url, status: 'error', urlCount: 0, depth: item.depth, error: `${res.kind}: ${res.message}` });
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          sitemapRecords.push({ url: item.url, status: 'missing', urlCount: 0, depth: item.depth });
          continue;
        }
        if (res.status !== 200 || res.bodySkipped) {
          sitemapRecords.push({ url: item.url, status: 'error', urlCount: 0, depth: item.depth, error: res.bodySkipped ? `unexpected content type ${res.contentType}` : `HTTP ${res.status}` });
          continue;
        }
        let parsed: ParsedSitemap;
        try {
          parsed = parseSitemap(res.body.toString('utf8'), res.contentType);
        } catch (err) {
          sitemapRecords.push({ url: item.url, status: 'error', urlCount: 0, depth: item.depth, error: `parse: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
        if (parsed.kind === 'unknown') {
          // A conventional guess that returned an HTML page, for instance.
          sitemapRecords.push({ url: item.url, status: item.declared ? 'error' : 'missing', kind: 'unknown', urlCount: 0, depth: item.depth, ...(item.declared ? { error: 'not a sitemap' } : {}) });
          continue;
        }
        // Each sitemap keeps at most the whole budget; the fair-share pass below decides what is admitted.
        const kept = parsed.urls.slice(0, budget.maxSitemapUrls);
        if (kept.length < parsed.urls.length) truncated = true;
        if (kept.length) buffers.push({ from: item.url, entries: kept });
        const added = kept.length;
        let childCount = 0;
        if (parsed.kind === 'index') {
          for (const child of parsed.children) {
            const normalizedChild = normalizeUrl(child, item.url, { keepQuery: true });
            if (!normalizedChild || !sitemapHostOk(normalizedChild)) continue;
            if (item.depth + 1 > budget.maxSitemapDepth) {
              truncated = true;
              continue;
            }
            childCount += 1;
            queue.push({ url: normalizedChild, depth: item.depth + 1, declared: true });
          }
        }
        sitemapRecords.push({ url: item.url, status: 'ok', kind: parsed.kind, urlCount: added, childCount, depth: item.depth });
        ctx.logger.info(`sitemap ${item.url}: ${parsed.kind}, ${added} urls, ${childCount} children`);
      }

      // Fair share: one URL from each sitemap in turn until the budget is spent.
      const cursors = buffers.map(() => 0);
      let admitted = 0;
      let progressed = true;
      while (progressed && admitted < budget.maxSitemapUrls) {
        progressed = false;
        for (let i = 0; i < buffers.length && admitted < budget.maxSitemapUrls; i += 1) {
          const buffer = buffers[i]!;
          const entry = buffer.entries[cursors[i]!];
          if (!entry) continue;
          cursors[i] = (cursors[i] ?? 0) + 1;
          addUrl(entry.loc, { kind: 'sitemap', from: buffer.from }, entry);
          admitted += 1;
          progressed = true;
        }
      }
      if (buffers.some((b, i) => cursors[i]! < b.entries.length)) truncated = true;

      const all = Array.from(urls.values());
      const inScopeUrls = all.filter((u) => u.inScope);
      const routeCandidates = buildRouteCandidates(inScopeUrls.map((u) => u.url));

      const data: URLInventoryData = {
        robots: robotsResult,
        sitemaps: sitemapRecords,
        urls: all,
        routeCandidates,
        stats: {
          total: all.length,
          inScope: inScopeUrls.length,
          outOfScope: all.length - inScopeUrls.length,
          fromSitemap: all.filter((u) => u.sources.some((s) => s.kind === 'sitemap')).length,
          robotsDisallowed: inScopeUrls.filter((u) => u.robotsAllowed === false).length,
          truncated,
        },
      };

      const artifact = {
        ...makeEnvelope({
          type: 'URLInventory',
          schemaVersion: URL_INVENTORY_VERSION,
          siteId: ctx.siteId,
          jobId: ctx.jobId,
          stage: 'stage2-sitemap',
          sources: [refTo(manifest)],
          now: ctx.now,
        }),
        data,
      };
      return [URLInventory.parse(artifact)];
    } finally {
      await http.close();
      await sitemapHttp?.close();
    }
  },
};

export function buildRouteCandidates(urls: string[], maxExamples = 3): RouteCandidate[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const pattern = urlPattern(url);
    const list = groups.get(pattern) ?? [];
    list.push(url);
    groups.set(pattern, list);
  }
  return Array.from(groups.entries())
    .map(([pattern, members]) => ({ pattern, count: members.length, examples: members.slice(0, maxExamples) }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}
