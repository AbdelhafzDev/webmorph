import { z } from 'zod';
import { defineArtifact } from './common.js';
import { ApiCredentialRef } from './siteConfig.js';

export const SITE_MANIFEST_VERSION = '1.4.0';

export const ScopePolicyData = z.object({
  origin: z.string().describe('Normalized origin of the start URL, e.g. https://example.com'),
  allowedHosts: z.array(z.string()).describe('Exact hostnames in scope. Redirects and links elsewhere are never followed.'),
  allowPrivateNetwork: z.boolean().describe('Permit localhost and private-network targets. Test fixtures only.'),
  respectRobots: z.boolean(),
  userAgent: z.string(),
});
export type ScopePolicyData = z.infer<typeof ScopePolicyData>;

export const Budget = z.object({
  maxPages: z.number().int().positive(),
  maxDepth: z.number().int().nonnegative(),
  maxRequests: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
  minDelayMs: z.number().int().nonnegative().describe('Minimum spacing between requests to the same host.'),
  requestTimeoutMs: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  maxRedirects: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  maxSitemaps: z.number().int().positive(),
  maxSitemapUrls: z.number().int().positive(),
  maxSitemapDepth: z.number().int().nonnegative(),
  maxLinksPerPage: z.number().int().positive(),
  // Browser stages (Phase 2). Defaults keep older manifests parseable.
  maxPagesToInspect: z.number().int().positive().default(15),
  maxElementsPerPage: z.number().int().positive().default(400),
  maxProbesPerPage: z.number().int().nonnegative().default(6),
  maxProbesTotal: z.number().int().nonnegative().default(30),
  pageLoadTimeoutMs: z.number().int().positive().default(20_000),
  settleTimeoutMs: z.number().int().positive().default(3_000),
  browserConcurrency: z.number().int().positive().default(2),
  validationRuns: z.number().int().positive().default(2),
  maxDocRequests: z.number().int().positive().default(25),
  maxNetworkRecords: z.number().int().positive().default(500),
  maxJsonPeekBytes: z.number().int().positive().default(262_144),
  // Model harness (D26). Defaults keep older manifests parseable.
  maxAgentTurns: z.number().int().positive().default(24).describe('Model turns in the stage 8 harness loop.'),
  maxAgentFetches: z.number().int().nonnegative().default(20).describe('Pages and JSON endpoints the model may read over HTTP during stage 8.'),
  maxAgentInspections: z.number().int().nonnegative().default(6).describe('Pages the model may open in the browser during stage 8.'),
  maxAgentProposals: z.number().int().nonnegative().default(12).describe('Capability proposals the model may submit for validation.'),
  maxAgentTokens: z.number().int().positive().default(600_000).describe('Input plus output tokens the harness may spend before it stops.'),
});
export type Budget = z.infer<typeof Budget>;

export const SiteManifestData = z.object({
  analysisVersion: z.string(),
  startUrl: z.string().describe('URL exactly as submitted.'),
  normalizedStartUrl: z.string(),
  scope: ScopePolicyData,
  budget: Budget,
  prohibited: z.object({
    hosts: z.array(z.string()),
    pathPatterns: z.array(z.string()).describe('Regular expressions; matching paths are never fetched.'),
    actions: z.array(z.string()).describe('Action classes never performed automatically, e.g. "purchase".'),
  }),
  auth: z.object({
    mode: z.enum(['none', 'session']),
    apiCredentials: z.array(ApiCredentialRef).default([]).describe('Operator-configured credentials by reference (name, host, header). Values live only in the mutable site config and never in an artifact.'),
  }),
  resolvedAddresses: z.array(z.string()).describe('Addresses the start host resolved to at validation time.'),
});
export type SiteManifestData = z.infer<typeof SiteManifestData>;

export const SiteManifest = defineArtifact('SiteManifest', SiteManifestData);
export type SiteManifest = z.infer<typeof SiteManifest>;
