import { z } from 'zod';
import { defineArtifact } from './common.js';
import { RenderModeKind } from './pageInventory.js';

export const PAGE_TEMPLATES_VERSION = '1.0.0';

export const TemplateKind = z.enum([
  'home',
  'documentation',
  'search',
  'listing',
  'detail',
  'article',
  'auth',
  'account',
  'form',
  'legal',
  'other',
]);
export type TemplateKind = z.infer<typeof TemplateKind>;

export const PageTemplate = z.object({
  templateId: z.string(),
  urlPattern: z.string(),
  kind: TemplateKind,
  kindReasons: z.array(z.string()),
  pageCount: z.number().int().positive(),
  representativeUrls: z.array(z.string()).describe('Pages chosen for browser inspection.'),
  urls: z.array(z.string()).describe('All member URLs, capped.'),
  urlsTruncated: z.boolean(),
  skeletonHashes: z.array(z.object({ hash: z.string(), count: z.number().int().positive() })),
  cohesion: z.number().min(0).max(1).describe('Share of members with the dominant skeleton hash.'),
  renderModes: z.partialRecord(RenderModeKind, z.number().int().nonnegative()),
  hasForms: z.boolean(),
  formClassifications: z.array(z.string()),
});
export type PageTemplate = z.infer<typeof PageTemplate>;

export const PageTemplatesData = z.object({
  templates: z.array(PageTemplate),
  stats: z.object({
    pagesGrouped: z.number().int().nonnegative(),
    templateCount: z.number().int().nonnegative(),
    lowCohesionTemplates: z.number().int().nonnegative(),
  }),
});
export type PageTemplatesData = z.infer<typeof PageTemplatesData>;

export const PageTemplates = defineArtifact('PageTemplates', PageTemplatesData);
export type PageTemplates = z.infer<typeof PageTemplates>;
