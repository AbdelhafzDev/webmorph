import { z } from 'zod';
import { defineArtifact } from './common.js';
import { RenderModeKind } from './pageInventory.js';

export const CRAWL_REPORT_VERSION = '1.0.0';

export const CrawlReportData = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  budget: z.object({
    maxPages: z.number().int(),
    pagesAttempted: z.number().int(),
    maxRequests: z.number().int(),
    requestsMade: z.number().int(),
    maxDepth: z.number().int(),
    deepestDepth: z.number().int(),
    frontierRemaining: z.number().int().describe('In-scope URLs discovered but not fetched because a budget ran out.'),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  statusHistogram: z.record(z.string(), z.number().int().nonnegative()),
  byDepth: z.record(z.string(), z.number().int().nonnegative()),
  renderModes: z.partialRecord(RenderModeKind, z.number().int().nonnegative()),
  blockedSignals: z.array(z.object({ url: z.string(), signal: z.string() })),
  siteBlocked: z.boolean().describe('Blocked responses observed and no page fetched successfully.'),
  siteRenderMode: RenderModeKind.describe('Dominant render mode; spa-shell means later stages should go browser-first.'),
  warnings: z.array(z.string()),
});
export type CrawlReportData = z.infer<typeof CrawlReportData>;

export const CrawlReport = defineArtifact('CrawlReport', CrawlReportData);
export type CrawlReport = z.infer<typeof CrawlReport>;
