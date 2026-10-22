import { z } from 'zod';
import { ToolSpec } from './toolDefinition.js';

export const REGISTRY_VERSION = '1.0.0';

/** Lifecycle after approval. Validated tools in a job become published entries here. */
export const PublishedStatus = z.enum(['published', 'degraded', 'disabled']);
export type PublishedStatus = z.infer<typeof PublishedStatus>;

export const StatusChange = z.object({ at: z.iso.datetime(), from: z.string(), to: z.string(), reason: z.string() });

export const CallStats = z.object({
  total: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastCalledAt: z.iso.datetime().optional(),
  lastOkAt: z.iso.datetime().optional(),
  lastError: z.string().optional(),
});

export const PublishedTool = z.object({
  tool: ToolSpec,
  status: PublishedStatus,
  pinned: z.object({
    jobId: z.string(),
    manifestArtifactId: z.string(),
    toolDefinitionArtifactId: z.string(),
    validationReportArtifactId: z.string().optional(),
    validatedAt: z.iso.datetime().optional(),
  }),
  publishedAt: z.iso.datetime(),
  history: z.array(StatusChange),
  calls: CallStats,
});
export type PublishedTool = z.infer<typeof PublishedTool>;

/** Mutable, per-site registry of approved tools. Lives outside the immutable job folders. */
export const RegistryFile = z.object({
  schemaVersion: z.string(),
  siteId: z.string(),
  origin: z.string(),
  updatedAt: z.iso.datetime(),
  tools: z.record(z.string(), PublishedTool),
});
export type RegistryFile = z.infer<typeof RegistryFile>;
