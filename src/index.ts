import { resolve } from 'node:path';
import { FileArtifactStore, type JobRecord } from './core/store.js';
import { JobRunner, type Logger, silentLogger } from './core/job.js';
import { newJobId, siteIdFromOrigin } from './core/ids.js';
import { normalizeUrl, originOf } from './net/url.js';
import { InvalidTargetError } from './core/errors.js';
import { stage0Scope, stage1Docs, stage2Sitemap, stage3Crawl, stage4Plan, stage5Inspect, stage6Interact, stage7Network, stage8Model, stage9Workflows, stage10Generate, stage10Validate, stage11Skill, type DiscoveryInput } from './stages/index.js';
import type { StageDefinition } from './core/job.js';
import type { ApiCredential } from './schemas/siteConfig.js';

export * from './schemas/index.js';
export * from './core/errors.js';
export * from './core/ids.js';
export * from './core/store.js';
export * from './core/job.js';
export * from './net/url.js';
export * from './net/ssrf.js';
export * from './net/scope.js';
export * from './net/http.js';
export * from './html/extract.js';
export * from './html/renderMode.js';
export * from './html/templates.js';
export * from './html/blocked.js';
export * from './stages/index.js';
export { WEBMORPH_VERSION, ANALYSIS_VERSION } from './version.js';

export interface DiscoverOptions extends DiscoveryInput {
  /** Artifact store root. Defaults to ./.webmorph */
  outDir?: string;
  logger?: Logger;
  signal?: AbortSignal;
  /** Resume a previous job instead of starting a new one. */
  resumeJobId?: string;
  /** Override the stage list (tests). */
  stages?: StageDefinition<DiscoveryInput>[];
  /**
   * Operator-configured credentials for keyed public APIs (D23). Written to the mutable site config
   * before the job starts and never handed to a stage as input: stages see only references (name,
   * host, header) through the manifest, and the interpreter resolves values from the config at run time.
   */
  apiCredentials?: ApiCredential[];
}

export interface DiscoverResult {
  siteId: string;
  jobId: string;
  job: JobRecord;
  store: FileArtifactStore;
  jobDir: string;
}

/** Phase 1: scope, sitemap, static crawl. No browser. */
export const PHASE1_STAGES: StageDefinition<DiscoveryInput>[] = [stage0Scope, stage2Sitemap, stage3Crawl];

/** Phase 2 adds browser inspection and targeted interactions. */
export const PHASE2_STAGES: StageDefinition<DiscoveryInput>[] = [...PHASE1_STAGES, stage4Plan, stage5Inspect, stage6Interact];

/** Phase 3 adds the website model, tool generation and replay validation. */
export const PHASE3_STAGES: StageDefinition<DiscoveryInput>[] = [...PHASE2_STAGES, stage8Model, stage10Generate, stage10Validate];

/** Phase 5 adds documentation discovery and network evidence; APIs are preferred over the browser where they exist. */
export const PHASE5_STAGES: StageDefinition<DiscoveryInput>[] = [stage0Scope, stage1Docs, stage2Sitemap, stage3Crawl, stage4Plan, stage5Inspect, stage6Interact, stage7Network, stage8Model, stage10Generate, stage10Validate];

/** Phase 6 adds workflows reconstructed from recorded sessions. */
export const PHASE6_STAGES: StageDefinition<DiscoveryInput>[] = [stage0Scope, stage1Docs, stage2Sitemap, stage3Crawl, stage4Plan, stage5Inspect, stage6Interact, stage7Network, stage8Model, stage9Workflows, stage10Generate, stage10Validate];

/** Phase 8 adds the skill: a site's validated tools composed with guidance for an agent (Layer 3). */
export const PHASE8_STAGES: StageDefinition<DiscoveryInput>[] = [...PHASE6_STAGES, stage11Skill];

export const DEFAULT_STAGES = PHASE8_STAGES;

export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const normalized = normalizeUrl(options.startUrl, undefined, { keepQuery: true });
  if (!normalized) throw new InvalidTargetError(`Not a valid absolute URL: ${options.startUrl}`);
  const origin = originOf(normalized);
  const siteId = siteIdFromOrigin(origin);
  const store = new FileArtifactStore(resolve(options.outDir ?? '.webmorph'));
  const runner = new JobRunner<DiscoveryInput>(store, options.stages ?? DEFAULT_STAGES, {
    logger: options.logger ?? silentLogger,
    signal: options.signal,
  });

  const jobId = options.resumeJobId ?? newJobId();
  const job = options.resumeJobId ? await store.readJob(siteId, options.resumeJobId) : runner.createJob(siteId, jobId, options.startUrl);
  if (options.resumeJobId) {
    const wanted = (options.stages ?? DEFAULT_STAGES).map((s) => s.id);
    const recorded = job.stages.map((s) => s.id);
    if (wanted.join(',') !== recorded.join(',')) {
      throw new InvalidTargetError(`Cannot resume job ${jobId}: it was created with stages [${recorded.join(', ')}] but this run has [${wanted.join(', ')}]`);
    }
  }
  await store.upsertSite(siteId, origin, jobId);
  if (options.apiCredentials?.length) await store.upsertApiCredentials(siteId, options.apiCredentials);

  const { outDir: _outDir, logger: _logger, signal: _signal, resumeJobId: _resume, stages: _stages, apiCredentials: _credentials, ...input } = options;
  const finished = await runner.run(job, input);
  return { siteId, jobId, job: finished, store, jobDir: store.jobDir(siteId, jobId) };
}

export * from './browser/runtime.js';
export * from './browser/inspect.js';
export * from './browser/probes.js';
export * from './browser/locators.js';
export * from './browser/classify.js';
export * from './html/forms.js';
export * from './model/naming.js';
export * from './model/facts.js';
export * from './model/llm.js';
export * from './model/agent.js';
export * from './model/openai.js';
export * from './model/provider.js';
export * from './model/skill.js';
export * from './tools/jsonschema.js';
export * from './tools/generate.js';
export * from './tools/sample.js';
export * from './tools/interpreter.js';
export * from './registry/registry.js';
export * from './adapter/executor.js';
export * from './adapter/mcp.js';
export * from './docs/openapi.js';
export * from './docs/llms.js';
export * from './net/redact.js';
export * from './record/recorder.js';
export * from './record/instrument.js';
export * from './studio/server.js';
