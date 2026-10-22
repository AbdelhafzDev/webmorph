import { z } from 'zod';
import { defineArtifact, UrlSourceKind } from './common.js';

export const URL_INVENTORY_VERSION = '1.0.0';

export const UrlEntry = z.object({
  url: z.string().describe('Normalized URL.'),
  sources: z.array(
    z.object({
      kind: UrlSourceKind,
      from: z.string().optional().describe('Where this URL was seen: sitemap URL, referring page, etc.'),
      observedUrl: z.string().optional().describe('URL before normalization, when it differed.'),
    }),
  ),
  inScope: z.boolean(),
  robotsAllowed: z.boolean().optional(),
  lastmod: z.string().optional(),
  changefreq: z.string().optional(),
  priority: z.number().optional(),
});
export type UrlEntry = z.infer<typeof UrlEntry>;

export const SitemapRecord = z.object({
  url: z.string(),
  status: z.enum(['ok', 'missing', 'error', 'skipped']),
  kind: z.enum(['index', 'urlset', 'text', 'unknown']).optional(),
  urlCount: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative().optional(),
  depth: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type SitemapRecord = z.infer<typeof SitemapRecord>;

export const RouteCandidate = z.object({
  pattern: z.string().describe('Path pattern with {id} and {slug} placeholders, plus sorted query keys.'),
  count: z.number().int().positive(),
  examples: z.array(z.string()),
});
export type RouteCandidate = z.infer<typeof RouteCandidate>;

export const URLInventoryData = z.object({
  robots: z.object({
    url: z.string(),
    status: z.enum(['found', 'missing', 'error']),
    sitemaps: z.array(z.string()),
    error: z.string().optional(),
  }),
  sitemaps: z.array(SitemapRecord),
  urls: z.array(UrlEntry),
  routeCandidates: z.array(RouteCandidate),
  stats: z.object({
    total: z.number().int().nonnegative(),
    inScope: z.number().int().nonnegative(),
    outOfScope: z.number().int().nonnegative(),
    fromSitemap: z.number().int().nonnegative(),
    robotsDisallowed: z.number().int().nonnegative(),
    truncated: z.boolean().describe('True when a sitemap budget stopped discovery early.'),
  }),
});
export type URLInventoryData = z.infer<typeof URLInventoryData>;

export const URLInventory = defineArtifact('URLInventory', URLInventoryData);
export type URLInventory = z.infer<typeof URLInventory>;
