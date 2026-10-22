import type { StageDefinition } from '../core/job.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { WebsiteModel } from '../schemas/websiteModel.js';
import { ElementInventory } from '../schemas/elementInventory.js';
import { ToolDefinition, TOOL_DEFINITION_VERSION, type ToolDefinitionData } from '../schemas/toolDefinition.js';
import { generateToolSet } from '../tools/generate.js';
import { samplePageData, type PageSample } from '../tools/sample.js';
import { WorkflowDefinition } from '../schemas/workflowDefinition.js';
import { createHttpClient, makeEnvelope, refTo, type DiscoveryInput } from './shared.js';

/** Stage 10a: declarative tool definitions from read-only capabilities. Tools are data, never code. */
export const stage10Generate: StageDefinition<DiscoveryInput> = {
  id: 'stage10-generate',
  produces: ['ToolDefinition'],
  requires: ['stage8-model'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const model = await ctx.artifact('WebsiteModel', WebsiteModel);
    const elements = (await ctx.hasArtifact('ElementInventory')) ? await ctx.artifact('ElementInventory', ElementInventory) : undefined;
    const { budget } = manifest.data;
    const workflows = (await ctx.hasArtifact('WorkflowDefinition')) ? await ctx.artifact('WorkflowDefinition', WorkflowDefinition) : undefined;
    // Detail pages that get a page-data tool are read once more here: the crawl keeps no HTML, and the tool's output
    // schema describes the embedded JSON found on that sample page. A failed read only leaves the shape undescribed.
    let pageSamples: Record<string, PageSample> = {};
    const http = createHttpClient(manifest.data, ctx.input);
    try {
      pageSamples = await samplePageData(model.data, http, { logger: ctx.logger, signal: ctx.signal });
    } catch (err) {
      ctx.logger.warn(`generate: sampling detail pages failed, embedded JSON shapes stay undescribed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await http.close();
    }
    const { tools, apiGaps } = generateToolSet(model.data, { pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, elements, pageSamples }, workflows?.data.workflows ?? []);
    const byKind: Record<string, number> = {};
    const bySideEffect: Record<string, number> = {};
    for (const t of tools) {
      const kind = t.capabilityId.startsWith('workflow:') ? 'workflow' : model.data.capabilities.find((c) => c.capabilityId === t.capabilityId)?.kind ?? 'other';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      bySideEffect[t.sideEffectClass] = (bySideEffect[t.sideEffectClass] ?? 0) + 1;
    }
    const httpCount = tools.filter((t) => t.transport === 'http').length;
    const data: ToolDefinitionData = { tools, apiGaps, stats: { total: tools.length, byKind, bySideEffect, http: httpCount } };
    const sampled = Object.keys(pageSamples).length;
    ctx.logger.info(`generate: ${tools.length} tool(s), ${httpCount} over HTTP: ${tools.map((t) => t.name).join(', ') || 'none'}${sampled ? `; ${sampled} page(s) sampled` : ''}`);
    for (const gap of apiGaps) ctx.logger.info(`generate: no HTTP route for ${gap.name} (${gap.reason}): ${gap.detail}`);
    const sources = [refTo(manifest), refTo(model), ...(elements ? [refTo(elements)] : []), ...(workflows ? [refTo(workflows)] : [])];
    return [ToolDefinition.parse({ ...makeEnvelope({ type: 'ToolDefinition', schemaVersion: TOOL_DEFINITION_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage10-generate', sources, now: ctx.now }), data })];
  },
};
