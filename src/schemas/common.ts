import { z } from 'zod';

/** Version of the artifact envelope itself. Per-type data versions live in each type module. */
export const ENVELOPE_VERSION = '1.0.0';

export const ArtifactType = z.enum([
  'SiteManifest',
  'DocumentationIndex',
  'URLInventory',
  'PageInventory',
  'PageTemplates',
  'CrawlReport',
  'InspectionPlan',
  'PageModel',
  'ElementInventory',
  'InteractionEvidence',
  'StateTransition',
  'NetworkEvidence',
  'ApiCandidates',
  'WebsiteModel',
  'WorkflowDefinition',
  'ToolDefinition',
  'SkillDefinition',
  'ValidationReport',
  'RecordingSession',
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const StageId = z.enum([
  'stage0-scope',
  'stage1-docs',
  'stage2-sitemap',
  'stage3-crawl',
  'stage4-plan',
  'stage5-inspect',
  'stage6-interact',
  'stage7-network',
  'stage8-model',
  'stage9-workflows',
  'stage10-generate',
  'stage10-validate',
]);
export type StageId = z.infer<typeof StageId>;

export const ArtifactRef = z.object({
  artifactType: ArtifactType,
  artifactId: z.string(),
  jobId: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const Provenance = z.object({
  producer: z.string().describe('Component that produced the artifact, e.g. "webmorph/stage3-crawl".'),
  producerVersion: z.string(),
  method: z.enum(['deterministic', 'model-assisted', 'human']),
  notes: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Fields shared by every persisted artifact. */
export const ArtifactEnvelope = z.object({
  envelopeVersion: z.string(),
  schemaVersion: z.string().describe('Version of the data schema for this artifact type.'),
  artifactType: ArtifactType,
  artifactId: z.string(),
  siteId: z.string(),
  jobId: z.string(),
  stage: StageId,
  createdAt: z.iso.datetime(),
  sources: z.array(ArtifactRef).describe('Artifacts this one was derived from.'),
  provenance: Provenance,
});
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelope>;

/**
 * Build the full schema for one artifact type: the envelope with a literal
 * `artifactType` and a typed `data` payload.
 */
export function defineArtifact<T extends ArtifactType, D extends z.ZodType>(type: T, dataSchema: D) {
  return ArtifactEnvelope.extend({
    artifactType: z.literal(type),
    data: dataSchema,
  });
}

export type Artifact<D> = ArtifactEnvelope & { data: D };

/** Origin kinds for a discovered URL. */
export const UrlSourceKind = z.enum(['start', 'robots', 'sitemap', 'docs', 'link', 'canonical', 'redirect']);
export type UrlSourceKind = z.infer<typeof UrlSourceKind>;

/** Reference to binary or large evidence stored under the job's blobs/ directory. */
export const BlobRef = z.object({
  path: z.string().describe('Path relative to the job directory, e.g. blobs/screenshots/ab12.png'),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha1: z.string(),
});
export type BlobRef = z.infer<typeof BlobRef>;
