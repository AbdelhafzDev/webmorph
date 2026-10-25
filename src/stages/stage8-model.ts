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
import { WebsiteModel, WEBSITE_MODEL_VERSION, type Capability, type WebsiteModelData } from '../schemas/websiteModel.js';
import { buildDeterministicModel, type ModelSources } from '../model/facts.js';
import { buildEnrichmentPayload, Enrichment, ENRICHMENT_SYSTEM, mergeEnrichment, modelErrorMessage, type ModelClient } from '../model/llm.js';
import { createModelClient, type ModelProvider } from '../model/provider.js';
import { runModelHarness, type HarnessServices, type InspectionSummary, type ProposalVerdict } from '../model/agent.js';
import { BrowserRuntime } from '../browser/runtime.js';
import { inspectPage, type BlobWriter } from '../browser/inspect.js';
import { generateToolSet } from '../tools/generate.js';
import { BrowseSession } from '../model/browse.js';
import { toolNeedsBrowser } from '../tools/interpreter.js';
import { validateTool } from './stage10-validate.js';
import { createHttpClient, makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';
import type { ArtifactRef } from '../schemas/common.js';

export interface ModelOptions {
  /** Default true. When false, the model is built from evidence only. */
  enabled?: boolean;
  modelId?: string;
  /** anthropic (default) or openai; inferred from the model id or the keys in the environment when omitted. */
  provider?: ModelProvider;
  /** Injected client (tests). A client with turn() drives the harness loop; one without gets the one-shot enrichment. */
  client?: ModelClient;
  /** Default true: run the stage 8 harness loop (D26). False keeps the one-shot enrichment of D13. */
  harness?: boolean;
}

/**
 * Stage 8: the website model. Deterministic first; then the model harness (D26) reads the
 * evidence, explores within budget, renames and describes, and proposes capabilities that are
 * kept only when a generated tool validates against the live site. Mechanics never come from
 * the model's word alone: the policy layers bound every read and the replay decides.
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
    const sources: ModelSources = { manifest, inventory, pages, templates, report, pageModel, elements, evidence, docs, apiCandidates };

    let data: WebsiteModelData = buildDeterministicModel(sources);
    ctx.logger.info(`model: ${data.pageTypes.length} page types, ${data.entities.length} entities, ${data.capabilities.length} capabilities, ${data.facts.length} facts (deterministic baseline)`);

    let method: 'deterministic' | 'model-assisted' = 'deterministic';
    const opts = ctx.input.model ?? {};
    if (opts.enabled !== false) {
      const client = opts.client ?? createModelClient({ provider: opts.provider, modelId: opts.modelId });
      if (client.turn && opts.harness !== false) {
        const result = await runHarness(ctx, client, data, sources);
        data = result;
        method = 'model-assisted';
      } else {
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
          data.enrichment = { applied: false, model: client.id, rejected: [], error: modelErrorMessage(err) };
          ctx.logger.warn(`model: enrichment failed, keeping deterministic model: ${data.enrichment.error}`);
        }
      }
    }

    const sourceRefs: ArtifactRef[] = [refTo(manifest), refTo(inventory), refTo(pages), refTo(templates), refTo(report)];
    if (pageModel) sourceRefs.push(refTo(pageModel));
    if (elements) sourceRefs.push(refTo(elements));
    if (evidence) sourceRefs.push(refTo(evidence));
    if (docs) sourceRefs.push(refTo(docs));
    if (apiCandidates) sourceRefs.push(refTo(apiCandidates));
    const artifact = { ...makeEnvelope({ type: 'WebsiteModel', schemaVersion: WEBSITE_MODEL_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage8-model', sources: sourceRefs, now: ctx.now, method }), data };
    return [WebsiteModel.parse(artifact)];
  },
};

type Ctx = Parameters<StageDefinition<DiscoveryInput & { model?: ModelOptions }>['run']>[0];

/** Wire the harness to the real services: scoped HTTP, a lazily launched browser, and generate-then-replay validation. */
async function runHarness(ctx: Ctx, client: ModelClient, baseline: WebsiteModelData, sources: ModelSources): Promise<WebsiteModelData> {
  const manifest = sources.manifest.data;
  const { budget } = manifest;
  const scope = scopeFromManifest(manifest);
  const http = createHttpClient(manifest, ctx.input);
  const browserOpts = ctx.input.browser ?? {};
  const credentials = (await ctx.store.readSiteConfig(ctx.siteId)).apiCredentials;
  const blobs: BlobWriter = (subdir, contentType, data, ext) => ctx.store.writeBlob(ctx.siteId, ctx.jobId, subdir, contentType, data, ext);
  // Concurrent tool calls of one turn share one launch: the promise is memoized, not the instance.
  let runtime: BrowserRuntime | undefined;
  let launching: Promise<BrowserRuntime> | undefined;
  const getRuntime = (): Promise<BrowserRuntime> => {
    launching ??= (async () => {
      runtime = new BrowserRuntime({ scope, allowPrivate: manifest.scope.allowPrivateNetwork, userAgent: manifest.scope.userAgent, headed: browserOpts.headed, blockHeavyResources: browserOpts.blockHeavyResources, executablePath: browserOpts.executablePath, channel: browserOpts.channel, resolver: ctx.input.resolver });
      await runtime.launch();
      return runtime;
    })();
    return launching;
  };

  const inspect = async (url: string): Promise<InspectionSummary> => {
    const result = await inspectPage(await getRuntime(), { url, scope, pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, maxElementsPerPage: budget.maxElementsPerPage, maxLinksPerPage: budget.maxLinksPerPage, captureScreenshot: false, captureDom: false }, blobs);
    const p = result.page;
    return {
      url,
      finalUrl: p.finalUrl,
      title: p.title,
      headings: p.rendered.headings.slice(0, 20).map((h) => h.text),
      textSample: p.ariaSnapshotExcerpt.slice(0, 2000),
      dialogs: p.dialogs.map((d) => `${d.kind}: ${d.buttonNames.join(', ')}`),
      elements: result.elements.slice(0, 120).map((e) => ({ elementId: e.elementId, kind: e.kind, name: e.name, href: e.attributes.href, placeholder: e.attributes.placeholder, category: e.category })),
      forms: result.forms.map((f) => ({ formId: f.formId, action: f.action, method: f.method, classification: f.classification, fieldNames: f.fieldElementIds })),
    };
  };

  const validate = async (capability: Capability, model: WebsiteModelData): Promise<ProposalVerdict> => {
    const { tools } = generateToolSet({ ...model, capabilities: [capability] }, { pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, elements: sources.elements });
    const out: ProposalVerdict['tools'] = [];
    for (const tool of tools) {
      const rt = toolNeedsBrowser(tool) ? await getRuntime() : null;
      const v = await validateTool(rt, tool, { scope, pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, runs: 1, logger: ctx.logger, now: ctx.now, credentials });
      const output = v.runs[0]?.output as Record<string, unknown> | undefined;
      const data = output?.['data'];
      const results = output && Array.isArray(output['results']) ? (output['results'] as unknown[]).length : Array.isArray(data) ? data.length : data && typeof data === 'object' ? (Object.values(data as Record<string, unknown>).find((x) => Array.isArray(x)) as unknown[] | undefined)?.length : undefined;
      out.push({ name: tool.name, transport: tool.transport ?? 'browser', verdict: v.verdict, ...(v.failureReasons[0] ? { reason: v.failureReasons[0] } : {}), ...(results !== undefined ? { resultCount: results } : {}) });
    }
    return { validated: out.some((t) => t.verdict === 'validated'), tools: out };
  };

  // The browsing session (D27) shares the runtime and is created when the model first opens a page; its opens count as inspections.
  let session: BrowseSession | undefined;
  let opening: Promise<BrowseSession> | undefined;
  const browse = (): Promise<BrowseSession> => {
    opening ??= getRuntime().then((rt) => {
      session = new BrowseSession(rt, { scope, pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, maxElementsPerPage: budget.maxElementsPerPage, maxLinksPerPage: budget.maxLinksPerPage, maxActions: budget.maxAgentActions, maxOpens: Math.max(1, budget.maxAgentInspections) });
      return session;
    });
    return opening;
  };
  const withBrowser = budget.maxAgentInspections > 0;
  const services: HarnessServices = { scope, http, logger: ctx.logger, validate, today: ctx.now().toISOString().slice(0, 10), ...(withBrowser ? { inspect } : {}), ...(withBrowser && budget.maxAgentActions > 0 ? { browse } : {}) };
  try {
    const { model } = await runModelHarness(client, baseline, sources, services, { maxTurns: budget.maxAgentTurns, maxFetches: budget.maxAgentFetches, maxInspections: budget.maxAgentInspections, maxActions: budget.maxAgentActions, maxProposals: budget.maxAgentProposals, maxTokens: budget.maxAgentTokens });
    if (model.agent?.error) ctx.logger.warn(`model: harness stopped early: ${model.agent.error}`);
    return model;
  } finally {
    await session?.close();
    await runtime?.close();
    await http.close();
  }
}
