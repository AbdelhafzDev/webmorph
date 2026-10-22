import type { StageDefinition } from '../core/job.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { URLInventory } from '../schemas/urlInventory.js';
import { PageInventory } from '../schemas/pageInventory.js';
import { PageTemplates } from '../schemas/pageTemplates.js';
import { CrawlReport } from '../schemas/crawlReport.js';
import { PageModel } from '../schemas/pageModel.js';
import { ElementInventory } from '../schemas/elementInventory.js';
import { InteractionEvidence } from '../schemas/interactionEvidence.js';
import { DocumentationIndex } from '../schemas/documentationIndex.js';
import { ApiCandidates } from '../schemas/networkEvidence.js';
import { WebsiteModel, WEBSITE_MODEL_VERSION, type WebsiteModelData } from '../schemas/websiteModel.js';
import { buildDeterministicModel } from '../model/facts.js';
import { AnthropicModelClient, buildEnrichmentPayload, Enrichment, ENRICHMENT_SYSTEM, mergeEnrichment, type ModelClient } from '../model/llm.js';
import { makeEnvelope, refTo, type DiscoveryInput } from './shared.js';
import type { ArtifactRef } from '../schemas/common.js';
import { errorMessage } from '../core/errors.js';

export interface ModelOptions {
  /** Default true. When false, the model is built from evidence only. */
  enabled?: boolean;
  modelId?: string;
  /** Injected client (tests). */
  client?: ModelClient;
}

/**
 * Stage 8: the semantic website model. Deterministic first; a model may then
 * enrich descriptions and add cited hypotheses. Observed facts stay separate
 * from inferred ones, and nothing the model says can change mechanics.
 */
export const stage8Model: StageDefinition<DiscoveryInput & { model?: ModelOptions }> = {
  id: 'stage8-model',
  produces: ['WebsiteModel'],
  requires: ['stage3-crawl'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const inventory = await ctx.artifact('URLInventory', URLInventory);
    const pages = await ctx.artifact('PageInventory', PageInventory);
    const templates = await ctx.artifact('PageTemplates', PageTemplates);
    const report = await ctx.artifact('CrawlReport', CrawlReport);
    const pageModel = (await ctx.hasArtifact('PageModel')) ? await ctx.artifact('PageModel', PageModel) : undefined;
    const elements = (await ctx.hasArtifact('ElementInventory')) ? await ctx.artifact('ElementInventory', ElementInventory) : undefined;
    const evidence = (await ctx.hasArtifact('InteractionEvidence')) ? await ctx.artifact('InteractionEvidence', InteractionEvidence) : undefined;
    const docs = (await ctx.hasArtifact('DocumentationIndex')) ? await ctx.artifact('DocumentationIndex', DocumentationIndex) : undefined;
    const apiCandidates = (await ctx.hasArtifact('ApiCandidates')) ? await ctx.artifact('ApiCandidates', ApiCandidates) : undefined;

    let data: WebsiteModelData = buildDeterministicModel({ manifest, inventory, pages, templates, report, pageModel, elements, evidence, docs, apiCandidates });
    ctx.logger.info(`model: ${data.pageTypes.length} page types, ${data.entities.length} entities, ${data.capabilities.length} capabilities, ${data.facts.length} facts`);

    let method: 'deterministic' | 'model-assisted' = 'deterministic';
    const opts = ctx.input.model ?? {};
    if (opts.enabled !== false) {
      const client = opts.client ?? new AnthropicModelClient({ modelId: opts.modelId });
      try {
        const user = buildEnrichmentPayload({ model: data, pages, pageModel });
        const response = await client.complete({ system: ENRICHMENT_SYSTEM, user, schema: Enrichment, maxTokens: 16_000 });
        if (response.parsed) {
          const merged = mergeEnrichment(data, response.parsed, response.model, { inputTokens: response.inputTokens, outputTokens: response.outputTokens });
          data = merged.model;
          method = 'model-assisted';
          ctx.logger.info(`model: enriched by ${response.model} (${response.inputTokens} in / ${response.outputTokens} out, ${merged.rejected.length} suggestions rejected)`);
        } else {
          data.enrichment = { applied: false, model: response.model, rejected: [], error: response.error ?? 'no parsed output' };
          ctx.logger.warn(`model: enrichment skipped: ${data.enrichment.error}`);
        }
      } catch (err) {
        data.enrichment = { applied: false, model: client.id, rejected: [], error: errorMessage(err).split('\n')[0] };
        ctx.logger.warn(`model: enrichment failed, keeping deterministic model: ${data.enrichment.error}`);
      }
    }

    const sources: ArtifactRef[] = [refTo(manifest), refTo(inventory), refTo(pages), refTo(templates), refTo(report)];
    if (pageModel) sources.push(refTo(pageModel));
    if (elements) sources.push(refTo(elements));
    if (evidence) sources.push(refTo(evidence));
    if (docs) sources.push(refTo(docs));
    if (apiCandidates) sources.push(refTo(apiCandidates));
    const artifact = { ...makeEnvelope({ type: 'WebsiteModel', schemaVersion: WEBSITE_MODEL_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage8-model', sources, now: ctx.now, method }), data };
    return [WebsiteModel.parse(artifact)];
  },
};
