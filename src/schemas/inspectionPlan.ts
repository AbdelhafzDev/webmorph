import { z } from 'zod';
import { defineArtifact } from './common.js';
import { TemplateKind } from './pageTemplates.js';
import { RenderModeKind } from './pageInventory.js';

export const INSPECTION_PLAN_VERSION = '1.0.0';

export const InspectionEntry = z.object({
  url: z.string(),
  templateId: z.string().optional(),
  templateKind: TemplateKind.optional(),
  priority: z.number().int().describe('Lower runs first. 1 home and navigation, 2 landing, 3 search and listing, 4 detail, 5 forms, 7 client-rendered.'),
  reasons: z.array(z.string()),
  interactionsAllowed: z.boolean().describe('False for auth, account and legal pages: inspect only.'),
  staticRenderMode: RenderModeKind.optional(),
});
export type InspectionEntry = z.infer<typeof InspectionEntry>;

export const InspectionPlanData = z.object({
  strategy: z.enum(['representative', 'browser-first']).describe('browser-first when the static crawl saw an SPA shell.'),
  planner: z.enum(['heuristic', 'model']).default('heuristic').describe('model: the model chose which candidate pages to inspect (D26); heuristic otherwise, including when the model was unavailable.'),
  plannerNotes: z.array(z.string()).default([]).describe('What the model said about its choice, or why the heuristic plan was kept.'),
  siteRenderMode: RenderModeKind,
  entries: z.array(InspectionEntry),
  skipped: z.array(z.object({ url: z.string(), reason: z.string() })),
  budget: z.object({
    maxPagesToInspect: z.number().int(),
    maxProbesPerPage: z.number().int(),
    maxProbesTotal: z.number().int(),
  }),
  stats: z.object({
    candidates: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    templatesCovered: z.number().int().nonnegative(),
    templatesTotal: z.number().int().nonnegative(),
  }),
});
export type InspectionPlanData = z.infer<typeof InspectionPlanData>;

export const InspectionPlan = defineArtifact('InspectionPlan', InspectionPlanData);
export type InspectionPlan = z.infer<typeof InspectionPlan>;
