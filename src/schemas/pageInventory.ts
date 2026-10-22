import { z } from 'zod';
import { defineArtifact, UrlSourceKind } from './common.js';

export const PAGE_INVENTORY_VERSION = '1.0.0';

export const PageOutcome = z.enum([
  'ok',
  'redirected-out-of-scope',
  'non-html',
  'http-error',
  'blocked',
  'network-error',
  'robots-disallowed',
  'too-large',
  'budget-exhausted',
  'prohibited',
]);
export type PageOutcome = z.infer<typeof PageOutcome>;

export const LinkRecord = z.object({
  href: z.string().describe('Normalized absolute URL, used for deduplication.'),
  observed: z.string().optional().describe('The URL as published (trailing slash, query order kept) when it differs from href. This is what gets fetched.'),
  text: z.string(),
  rel: z.string().optional(),
  inScope: z.boolean(),
  nofollow: z.boolean(),
});
export type LinkRecord = z.infer<typeof LinkRecord>;

export const FormField = z.object({
  name: z.string().optional(),
  type: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean(),
  optionCount: z.number().int().nonnegative().optional(),
});
export type FormField = z.infer<typeof FormField>;

export const FormClassification = z.enum(['search', 'filter', 'login', 'signup', 'contact', 'subscribe', 'unknown']);
export type FormClassification = z.infer<typeof FormClassification>;

export const FormRecord = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  action: z.string().describe('Resolved absolute action URL.'),
  method: z.enum(['get', 'post', 'other']),
  fields: z.array(FormField),
  submitText: z.string().optional(),
  hasPassword: z.boolean(),
  classification: FormClassification,
  sideEffectHint: z.enum(['read', 'write', 'unknown']).describe('GET forms without password are read; POST or password forms are write.'),
});
export type FormRecord = z.infer<typeof FormRecord>;

export const RenderModeKind = z.enum(['static', 'hybrid', 'spa-shell']);
export type RenderModeKind = z.infer<typeof RenderModeKind>;

export const RenderMode = z.object({
  kind: RenderModeKind,
  textDensity: z.number().describe('Visible text length divided by HTML length.'),
  reasons: z.array(z.string()),
});
export type RenderMode = z.infer<typeof RenderMode>;

export const HtmlFacts = z.object({
  title: z.string().optional(),
  lang: z.string().optional(),
  description: z.string().optional(),
  canonical: z.string().optional(),
  robotsMeta: z.string().optional(),
  headings: z.array(z.object({ level: z.number().int().min(1).max(6), text: z.string() })),
  htmlLength: z.number().int().nonnegative(),
  textLength: z.number().int().nonnegative(),
  textSample: z.string(),
  links: z.array(LinkRecord),
  internalLinkCount: z.number().int().nonnegative(),
  externalLinkCount: z.number().int().nonnegative(),
  linksTruncated: z.boolean(),
  forms: z.array(FormRecord),
  scripts: z.object({
    count: z.number().int().nonnegative(),
    externalCount: z.number().int().nonnegative(),
    frameworks: z.array(z.string()),
    hasRootMount: z.boolean().describe('An empty mount node such as #root, #app or #__next was found.'),
  }),
  jsonLdTypes: z.array(z.string()),
  renderMode: RenderMode,
  skeletonHash: z.string().describe('Hash of the depth-limited tag structure, used to group templates.'),
});
export type HtmlFacts = z.infer<typeof HtmlFacts>;

export const PageRecord = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  redirectChain: z.array(z.object({ url: z.string(), status: z.number().int() })),
  status: z.number().int().optional(),
  contentType: z.string().optional(),
  depth: z.number().int().nonnegative(),
  discoveredVia: UrlSourceKind,
  fetchedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  outcome: PageOutcome,
  blockedSignal: z.string().optional(),
  error: z.string().optional(),
  html: HtmlFacts.optional(),
});
export type PageRecord = z.infer<typeof PageRecord>;

export const PageInventoryData = z.object({
  pages: z.array(PageRecord),
  stats: z.object({
    attempted: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    byOutcome: z.record(z.string(), z.number().int().nonnegative()),
  }),
});
export type PageInventoryData = z.infer<typeof PageInventoryData>;

export const PageInventory = defineArtifact('PageInventory', PageInventoryData);
export type PageInventory = z.infer<typeof PageInventory>;
