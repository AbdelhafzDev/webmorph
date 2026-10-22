import { z } from 'zod';
import { BlobRef, defineArtifact } from './common.js';
import { LocatorCandidate } from './elementInventory.js';

export const INTERACTION_EVIDENCE_VERSION = '1.0.0';
export const STATE_TRANSITION_VERSION = '1.0.0';

export const ProbeKind = z.enum(['search-submit', 'filter-change', 'pagination', 'tab-change', 'menu-open', 'accordion-expand', 'expand-toggle', 'dialog-open', 'form-submit-write']);
export type ProbeKind = z.infer<typeof ProbeKind>;

export const ProbeAction = z.object({
  type: z.enum(['fill-and-submit', 'click', 'select-option']),
  locator: LocatorCandidate,
  value: z.string().optional().describe('Typed value or selected option label. Never a sensitive value.'),
});
export type ProbeAction = z.infer<typeof ProbeAction>;

export const PageState = z.object({
  url: z.string(),
  title: z.string().optional(),
  textLength: z.number().int().nonnegative(),
  interactiveCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  dialogCount: z.number().int().nonnegative(),
  stateHash: z.string(),
  links: z.array(z.string()).optional().describe('Up to 100 link targets seen on the page; lets later stages reason about where a probe landed.'),
  screenshot: BlobRef.optional(),
});
export type PageState = z.infer<typeof PageState>;

export const ProbeOutcome = z.enum(['navigated', 'changed', 'unchanged', 'error', 'skipped']);
export type ProbeOutcome = z.infer<typeof ProbeOutcome>;

export const ProbeRecord = z.object({
  probeId: z.string(),
  pageUrl: z.string(),
  kind: ProbeKind,
  targetElementId: z.string(),
  targetDescription: z.string(),
  action: ProbeAction,
  allowedBecause: z.string().describe('The policy rule that permitted this probe.'),
  before: PageState.optional(),
  after: PageState.optional(),
  waitedFor: z.enum(['navigation', 'dom-stable', 'timeout', 'none']),
  outcome: ProbeOutcome,
  changes: z
    .object({
      urlChanged: z.boolean(),
      titleChanged: z.boolean(),
      textDelta: z.number().int(),
      interactiveDelta: z.number().int(),
      dialogOpened: z.boolean(),
      targetStateAfter: z.record(z.string(), z.string()).optional().describe('aria-expanded, aria-selected etc. on the target after the action.'),
    })
    .optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  restored: z.boolean().describe('Always true: every probe runs in a fresh browser context that is discarded afterwards.'),
});
export type ProbeRecord = z.infer<typeof ProbeRecord>;

export const InteractionEvidenceData = z.object({
  probes: z.array(ProbeRecord),
  policy: z.object({
    allowWriteProbes: z.boolean(),
    neverClickPatterns: z.array(z.string()),
    neverFillTypes: z.array(z.string()),
  }),
  evidenceLog: z.string().describe('Path of the JSON Lines log, relative to the job directory.'),
  stats: z.object({
    planned: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    byOutcome: z.record(z.string(), z.number().int().nonnegative()),
    skippedByPolicy: z.number().int().nonnegative(),
    skippedByBudget: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative().default(0).describe('Probes skipped because the same control was already probed on another page.'),
  }),
});
export type InteractionEvidenceData = z.infer<typeof InteractionEvidenceData>;

export const InteractionEvidence = defineArtifact('InteractionEvidence', InteractionEvidenceData);
export type InteractionEvidence = z.infer<typeof InteractionEvidence>;

export const StateTransitionRecord = z.object({
  transitionId: z.string(),
  probeId: z.string(),
  kind: ProbeKind,
  from: z.object({ url: z.string(), stateHash: z.string() }),
  to: z.object({ url: z.string(), stateHash: z.string() }),
  effect: z.enum(['navigation', 'in-page-change']),
  summary: z.string(),
});
export type StateTransitionRecord = z.infer<typeof StateTransitionRecord>;

export const StateTransitionData = z.object({
  transitions: z.array(StateTransitionRecord),
  stats: z.object({ total: z.number().int().nonnegative(), navigations: z.number().int().nonnegative(), inPageChanges: z.number().int().nonnegative() }),
});
export type StateTransitionData = z.infer<typeof StateTransitionData>;

export const StateTransition = defineArtifact('StateTransition', StateTransitionData);
export type StateTransition = z.infer<typeof StateTransition>;
