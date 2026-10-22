import type { ArtifactEnvelope, ArtifactRef, ArtifactType, StageId } from '../schemas/common.js';
import { ENVELOPE_VERSION } from '../schemas/common.js';
import type { Budget, SiteManifestData } from '../schemas/siteManifest.js';
import { SafeHttpClient } from '../net/http.js';
import { ScopePolicy } from '../net/scope.js';
import type { Resolver } from '../net/ssrf.js';
import { newArtifactId } from '../core/ids.js';
import { WEBMORPH_VERSION } from '../version.js';
import type { ModelClient } from '../model/llm.js';

/** Operator input for a discovery job. Everything here ends up in the SiteManifest. */
export interface DiscoveryInput {
  startUrl: string;
  allowedHosts?: string[];
  allowPrivate?: boolean;
  respectRobots?: boolean;
  userAgent?: string;
  budget?: Partial<Budget>;
  prohibitedPathPatterns?: string[];
  /** Test hook: replaces system DNS. */
  resolver?: Resolver;
  /** Test hook: replaces real waiting in the HTTP client. */
  sleep?: (ms: number) => Promise<void>;
  /** Browser stage options. */
  browser?: BrowserOptions;
  /** Model-assisted enrichment options (Stage 8). */
  model?: { enabled?: boolean; modelId?: string; client?: ModelClient; harness?: boolean };
}

export interface BrowserOptions {
  /** Run a visible browser. Debugging only. */
  headed?: boolean;
  /** Skip images, media and fonts to save bandwidth and time. Default true. */
  blockHeavyResources?: boolean;
  /** Run Stage 6 interaction probes. Default true. */
  interactions?: boolean;
  /** Permit probes that submit non-sensitive POST forms. Default false. */
  allowWriteProbes?: boolean;
  /** Use a specific Chromium binary or channel. */
  executablePath?: string;
  channel?: string;
}

export const DEFAULT_USER_AGENT = `WebMorph/${WEBMORPH_VERSION} (+https://github.com/webmorph; website capability discovery)`;

export const DEFAULT_BUDGET: Budget = {
  maxPages: 50,
  maxDepth: 3,
  maxRequests: 300,
  maxConcurrency: 4,
  minDelayMs: 500,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  maxRetries: 2,
  maxSitemaps: 20,
  maxSitemapUrls: 5_000,
  maxSitemapDepth: 2,
  maxLinksPerPage: 500,
  maxPagesToInspect: 15,
  maxElementsPerPage: 400,
  maxProbesPerPage: 6,
  maxProbesTotal: 30,
  pageLoadTimeoutMs: 20_000,
  settleTimeoutMs: 3_000,
  browserConcurrency: 2,
  validationRuns: 2,
  maxDocRequests: 25,
  maxNetworkRecords: 500,
  maxJsonPeekBytes: 262_144,
  maxAgentTurns: 24,
  maxAgentFetches: 20,
  maxAgentInspections: 6,
  maxAgentProposals: 12,
  maxAgentTokens: 600_000,
};

export const DEFAULT_PROHIBITED_ACTIONS = ['purchase', 'payment', 'delete', 'account-change', 'message-send'];

export function createHttpClient(manifest: SiteManifestData, input: DiscoveryInput): SafeHttpClient {
  const scope = new ScopePolicy(manifest.scope, { hosts: manifest.prohibited.hosts, pathPatterns: manifest.prohibited.pathPatterns });
  return new SafeHttpClient({
    scope,
    allowPrivate: manifest.scope.allowPrivateNetwork,
    userAgent: manifest.scope.userAgent,
    requestTimeoutMs: manifest.budget.requestTimeoutMs,
    maxResponseBytes: manifest.budget.maxResponseBytes,
    maxRedirects: manifest.budget.maxRedirects,
    maxRetries: manifest.budget.maxRetries,
    minDelayMs: manifest.budget.minDelayMs,
    maxConcurrency: manifest.budget.maxConcurrency,
    maxRequests: manifest.budget.maxRequests,
    resolver: input.resolver,
    sleep: input.sleep,
  });
}

export function scopeFromManifest(manifest: SiteManifestData): ScopePolicy {
  return new ScopePolicy(manifest.scope, { hosts: manifest.prohibited.hosts, pathPatterns: manifest.prohibited.pathPatterns });
}

export interface EnvelopeParams {
  type: ArtifactType;
  schemaVersion: string;
  siteId: string;
  jobId: string;
  stage: StageId;
  sources: ArtifactRef[];
  now: () => Date;
  method?: 'deterministic' | 'model-assisted' | 'human';
  notes?: string;
}

export function makeEnvelope(p: EnvelopeParams): ArtifactEnvelope {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    schemaVersion: p.schemaVersion,
    artifactType: p.type,
    artifactId: newArtifactId(),
    siteId: p.siteId,
    jobId: p.jobId,
    stage: p.stage,
    createdAt: p.now().toISOString(),
    sources: p.sources,
    provenance: {
      producer: `webmorph/${p.stage}`,
      producerVersion: WEBMORPH_VERSION,
      method: p.method ?? 'deterministic',
      ...(p.notes ? { notes: p.notes } : {}),
    },
  };
}

export function refTo(artifact: ArtifactEnvelope): ArtifactRef {
  return { artifactType: artifact.artifactType, artifactId: artifact.artifactId, jobId: artifact.jobId };
}
