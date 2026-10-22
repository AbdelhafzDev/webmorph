import { z } from 'zod';
import { BlobRef, defineArtifact } from './common.js';

export const PAGE_MODEL_VERSION = '1.0.0';

export const RegionRecord = z.object({
  role: z.string().describe('Landmark role: navigation, main, banner, contentinfo, complementary, search, form, region, dialog.'),
  name: z.string().optional(),
  interactiveCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
});
export type RegionRecord = z.infer<typeof RegionRecord>;

export const DialogRecord = z.object({
  role: z.string(),
  name: z.string().optional(),
  kind: z.enum(['consent', 'auth', 'newsletter', 'other']),
  modal: z.boolean(),
  textSample: z.string(),
  buttonNames: z.array(z.string()),
});
export type DialogRecord = z.infer<typeof DialogRecord>;

export const InspectedPage = z.object({
  url: z.string(),
  finalUrl: z.string(),
  templateId: z.string().optional(),
  status: z.number().int().optional(),
  outcome: z.enum(['ok', 'navigation-failed', 'blocked', 'timeout', 'out-of-scope', 'error']),
  error: z.string().optional(),
  blockedSignal: z.string().optional(),
  title: z.string().optional(),
  loadMs: z.number().int().nonnegative(),
  settled: z.boolean().describe('DOM stopped changing within the settle timeout.'),
  rendered: z.object({
    textLength: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    interactiveCount: z.number().int().nonnegative(),
    headings: z.array(z.object({ level: z.number().int(), text: z.string() })),
    stateHash: z.string(),
  }),
  hydration: z.object({
    staticTextLength: z.number().int().nonnegative().optional(),
    renderedTextLength: z.number().int().nonnegative(),
    delta: z.number().int().optional().describe('Rendered minus static text length. Large positive values mean client rendering matters.'),
  }),
  regions: z.array(RegionRecord),
  dialogs: z.array(DialogRecord),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.object({ url: z.string(), reason: z.string() })),
  blockedRequests: z.number().int().nonnegative().describe('Requests refused by scope or SSRF policy in the browser.'),
  ariaSnapshotExcerpt: z.string(),
  ariaSnapshot: BlobRef.optional(),
  screenshot: BlobRef.optional(),
  domSnapshot: BlobRef.optional(),
});
export type InspectedPage = z.infer<typeof InspectedPage>;

export const PageModelData = z.object({
  pages: z.array(InspectedPage),
  stats: z.object({
    planned: z.number().int().nonnegative(),
    inspected: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    byOutcome: z.record(z.string(), z.number().int().nonnegative()),
    clientRenderedPages: z.number().int().nonnegative().describe('Pages whose rendered text exceeded the static text by a wide margin.'),
  }),
});
export type PageModelData = z.infer<typeof PageModelData>;

export const PageModel = defineArtifact('PageModel', PageModelData);
export type PageModel = z.infer<typeof PageModel>;
