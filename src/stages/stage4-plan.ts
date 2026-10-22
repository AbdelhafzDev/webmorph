import type { StageDefinition } from '../core/job.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { URLInventory } from '../schemas/urlInventory.js';
import { PageInventory } from '../schemas/pageInventory.js';
import { PageTemplates, type TemplateKind } from '../schemas/pageTemplates.js';
import { CrawlReport } from '../schemas/crawlReport.js';
import { InspectionPlan, INSPECTION_PLAN_VERSION, type InspectionEntry, type InspectionPlanData } from '../schemas/inspectionPlan.js';
import { makeEnvelope, refTo, type DiscoveryInput } from './shared.js';

/** How many representatives of each template kind deserve a browser session. */
const QUOTA: Record<TemplateKind, number> = {
  home: 1,
  search: 2,
  listing: 2,
  detail: 2,
  documentation: 1,
  article: 1,
  form: 1,
  auth: 1,
  account: 0,
  legal: 0,
  other: 1,
};

/** Plan ordering from the product plan: home and navigation first, client-rendered pages pulled forward because static evidence is missing. */
const PRIORITY: Record<TemplateKind, number> = {
  home: 1,
  other: 5,
  search: 3,
  listing: 3,
  detail: 4,
  documentation: 4,
  article: 4,
  form: 5,
  auth: 6,
  account: 6,
  legal: 8,
};

/** Single-page "other" templates are plentiful on real sites; cap them so forms and auth pages are not crowded out. */
const OTHER_CAP = 3;

const NO_INTERACTIONS: ReadonlySet<TemplateKind> = new Set(['auth', 'account', 'legal']);

/**
 * Stage 4: choose which pages get a browser session and why. Representative
 * pages per template normally; every route when the static crawl only saw an SPA shell.
 */
export const stage4Plan: StageDefinition<DiscoveryInput> = {
  id: 'stage4-plan',
  produces: ['InspectionPlan'],
  requires: ['stage0-scope', 'stage3-crawl'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const templates = await ctx.artifact('PageTemplates', PageTemplates);
    const report = await ctx.artifact('CrawlReport', CrawlReport);
    const pages = await ctx.artifact('PageInventory', PageInventory);
    const inventory = await ctx.artifact('URLInventory', URLInventory);
    const { budget } = manifest.data;
    const startUrl = manifest.data.normalizedStartUrl;
    const authAvailable = manifest.data.auth.mode === 'session';

    const renderModeOf = new Map<string, InspectionEntry['staticRenderMode']>();
    for (const p of pages.data.pages) if (p.html) renderModeOf.set(p.finalUrl, p.html.renderMode.kind);

    const entries = new Map<string, InspectionEntry>();
    const skipped: InspectionPlanData['skipped'] = [];
    const add = (entry: InspectionEntry) => {
      const existing = entries.get(entry.url);
      if (existing) {
        existing.reasons.push(...entry.reasons.filter((r) => !existing.reasons.includes(r)));
        existing.priority = Math.min(existing.priority, entry.priority);
        return;
      }
      entries.set(entry.url, entry);
    };

    const strategy: InspectionPlanData['strategy'] = report.data.siteRenderMode === 'spa-shell' ? 'browser-first' : 'representative';
    // The start URL always comes first, whatever template it belongs to.
    add({ url: startUrl, priority: 0, reasons: ['start URL'], interactionsAllowed: true, staticRenderMode: renderModeOf.get(startUrl) });

    let templatesCovered = 0;
    let otherTaken = 0;
    if (strategy === 'representative') {
      for (const t of templates.data.templates) {
        const quota = QUOTA[t.kind];
        if (t.kind === 'other') {
          const clientRenderedOther = (t.renderModes['spa-shell'] ?? 0) > 0;
          if (otherTaken >= OTHER_CAP && !clientRenderedOther) {
            skipped.push({ url: t.representativeUrls[0] ?? t.urlPattern, reason: `other template beyond cap of ${OTHER_CAP}` });
            continue;
          }
          otherTaken += 1;
        }
        if (quota === 0) {
          skipped.push({ url: t.representativeUrls[0] ?? t.urlPattern, reason: `${t.kind} template: no browser inspection in v1` });
          continue;
        }
        const clientRendered = (t.renderModes['spa-shell'] ?? 0) + (t.renderModes['hybrid'] ?? 0) > 0;
        const take = clientRendered ? Math.max(quota, 1) : quota;
        const picked = t.representativeUrls.slice(0, take);
        if (picked.length) templatesCovered += 1;
        for (const url of picked) {
          const reasons = [`representative of ${t.kind} template ${t.urlPattern} (${t.pageCount} pages)`];
          if (t.hasForms) reasons.push(`forms: ${t.formClassifications.join(', ') || 'unclassified'}`);
          const mode = renderModeOf.get(url);
          let priority = PRIORITY[t.kind];
          if (mode === 'spa-shell') {
            reasons.push('static HTML was a client-side shell');
            priority = Math.min(priority, 3);
          } else if (mode === 'hybrid') reasons.push('framework-hydrated markup');
          add({
            url,
            templateId: t.templateId,
            templateKind: t.kind,
            priority,
            reasons,
            interactionsAllowed: !NO_INTERACTIONS.has(t.kind) && (t.kind !== 'auth' || authAvailable),
            staticRenderMode: mode,
          });
        }
      }
    } else {
      // Browser-first: static templates are untrustworthy, so sample routes from the URL inventory instead.
      for (const route of inventory.data.routeCandidates) {
        const url = route.examples[0];
        if (!url) continue;
        add({ url, priority: 3, reasons: [`route ${route.pattern} (${route.count} urls); site renders client-side`], interactionsAllowed: true, staticRenderMode: renderModeOf.get(url) });
      }
      for (const p of pages.data.pages) {
        if (p.outcome === 'ok') add({ url: p.finalUrl, priority: 4, reasons: ['fetched during static crawl'], interactionsAllowed: true, staticRenderMode: renderModeOf.get(p.finalUrl) });
      }
    }

    const ordered = Array.from(entries.values()).sort((a, b) => a.priority - b.priority || a.url.length - b.url.length || a.url.localeCompare(b.url));
    const selected = ordered.slice(0, budget.maxPagesToInspect);
    for (const dropped of ordered.slice(budget.maxPagesToInspect)) skipped.push({ url: dropped.url, reason: 'maxPagesToInspect reached' });

    const data: InspectionPlanData = {
      strategy,
      siteRenderMode: report.data.siteRenderMode,
      entries: selected,
      skipped,
      budget: { maxPagesToInspect: budget.maxPagesToInspect, maxProbesPerPage: budget.maxProbesPerPage, maxProbesTotal: budget.maxProbesTotal },
      stats: { candidates: ordered.length, selected: selected.length, templatesCovered, templatesTotal: templates.data.templates.length },
    };
    ctx.logger.info(`plan: ${strategy}, ${selected.length} of ${ordered.length} candidate pages selected`);
    const artifact = {
      ...makeEnvelope({ type: 'InspectionPlan', schemaVersion: INSPECTION_PLAN_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage4-plan', sources: [refTo(manifest), refTo(templates), refTo(report), refTo(pages), refTo(inventory)], now: ctx.now }),
      data,
    };
    return [InspectionPlan.parse(artifact)];
  },
};
