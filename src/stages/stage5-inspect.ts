import type { StageDefinition } from '../core/job.js';
import { runPool } from '../core/pool.js';
import { BrowserRuntime } from '../browser/runtime.js';
import { inspectPage, type BlobWriter } from '../browser/inspect.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { PageInventory } from '../schemas/pageInventory.js';
import { InspectionPlan } from '../schemas/inspectionPlan.js';
import { PageModel, PAGE_MODEL_VERSION, type InspectedPage, type PageModelData } from '../schemas/pageModel.js';
import { ElementInventory, ELEMENT_INVENTORY_VERSION, type ElementInventoryData, type ElementRecord, type FormInventoryRecord } from '../schemas/elementInventory.js';
import { makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

/**
 * Stage 5: load planned pages in an isolated browser, capture the rendered
 * state, accessibility snapshot, element inventory with ranked locators, and
 * screenshots. Identifies candidate actions without assuming they work.
 */
export const stage5Inspect: StageDefinition<DiscoveryInput> = {
  id: 'stage5-inspect',
  produces: ['PageModel', 'ElementInventory'],
  requires: ['stage4-plan'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const plan = await ctx.artifact('InspectionPlan', InspectionPlan);
    const pages = await ctx.artifact('PageInventory', PageInventory);
    const { budget, scope: scopeData } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const browserOpts = ctx.input.browser ?? {};

    const staticText = new Map<string, number>();
    for (const p of pages.data.pages) {
      if (p.html) {
        staticText.set(p.finalUrl, p.html.textLength);
        staticText.set(p.requestedUrl, p.html.textLength);
      }
    }

    const runtime = new BrowserRuntime({
      scope,
      allowPrivate: scopeData.allowPrivateNetwork,
      userAgent: scopeData.userAgent,
      headed: browserOpts.headed,
      blockHeavyResources: browserOpts.blockHeavyResources,
      executablePath: browserOpts.executablePath,
      channel: browserOpts.channel,
      resolver: ctx.input.resolver,
      maxNetworkRecords: budget.maxNetworkRecords,
      maxJsonPeekBytes: budget.maxJsonPeekBytes,
      now: ctx.now,
    });
    const blobs: BlobWriter = (subdir, contentType, data, ext) => ctx.store.writeBlob(ctx.siteId, ctx.jobId, subdir, contentType, data, ext);
    const networkSink = async (records: import('../schemas/networkEvidence.js').NetworkRecord[]) => {
      for (const r of records) await ctx.store.appendEvidence(ctx.siteId, ctx.jobId, 'network', r);
    };

    const inspected: InspectedPage[] = [];
    const elements: ElementRecord[] = [];
    const forms: FormInventoryRecord[] = [];
    let truncatedPages = 0;

    await runtime.launch();
    try {
      const results = await runPool(
        plan.data.entries,
        budget.browserConcurrency,
        async (entry) => {
          const result = await inspectPage(
            runtime,
            {
              url: entry.url,
              templateId: entry.templateId,
              staticTextLength: staticText.get(entry.url),
              scope,
              pageLoadTimeoutMs: budget.pageLoadTimeoutMs,
              settleTimeoutMs: budget.settleTimeoutMs,
              maxElementsPerPage: budget.maxElementsPerPage,
              maxLinksPerPage: Math.min(budget.maxLinksPerPage, 200),
              captureScreenshot: true,
              captureDom: true,
            },
            blobs,
            networkSink,
          );
          ctx.logger.info(`inspect ${result.page.outcome} ${entry.url}: ${result.elements.length} elements, ${result.forms.length} forms, ${result.page.loadMs}ms`);
          return result;
        },
        ctx.signal,
      );
      for (const r of results) {
        if (!r) continue;
        inspected.push(r.page);
        elements.push(...r.elements);
        forms.push(...r.forms);
        if (r.truncated) truncatedPages += 1;
      }
    } finally {
      await runtime.close();
    }

    const byOutcome: Record<string, number> = {};
    for (const p of inspected) byOutcome[p.outcome] = (byOutcome[p.outcome] ?? 0) + 1;
    const clientRendered = inspected.filter((p) => p.outcome === 'ok' && p.hydration.delta !== undefined && p.hydration.delta >= 100 && p.hydration.delta >= (p.hydration.staticTextLength ?? 0) * 0.5).length;
    const byKind: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const e of elements) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    }

    const pageModelData: PageModelData = {
      pages: inspected,
      stats: { planned: plan.data.entries.length, inspected: inspected.length, ok: byOutcome['ok'] ?? 0, byOutcome, clientRenderedPages: clientRendered },
    };
    const inventoryData: ElementInventoryData = {
      elements,
      forms,
      stats: { pages: inspected.filter((p) => p.outcome === 'ok').length, elements: elements.length, withUniqueLocator: elements.filter((e) => e.locators.some((l) => l.unique)).length, byKind, byCategory, truncatedPages },
    };

    const common = { siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage5-inspect' as const, now: ctx.now, sources: [refTo(manifest), refTo(plan), refTo(pages)] };
    const pageModel = PageModel.parse({ ...makeEnvelope({ ...common, type: 'PageModel', schemaVersion: PAGE_MODEL_VERSION }), data: pageModelData });
    const elementInventory = ElementInventory.parse({ ...makeEnvelope({ ...common, type: 'ElementInventory', schemaVersion: ELEMENT_INVENTORY_VERSION, sources: [...common.sources, refTo(pageModel)] }), data: inventoryData });
    ctx.logger.info(`inspect: ${pageModelData.stats.ok}/${inspected.length} pages ok, ${elements.length} elements (${inventoryData.stats.withUniqueLocator} with a unique locator), ${forms.length} forms`);
    return [pageModel, elementInventory];
  },
};
