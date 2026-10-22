import { z } from 'zod';
import { defineArtifact } from './common.js';
import { ToolStep } from './toolDefinition.js';
import { CapabilityInput, EvidenceRef } from './websiteModel.js';

export const WORKFLOW_DEFINITION_VERSION = '1.0.0';

export const WorkflowDefinitionRecord = z.object({
  workflowId: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  title: z.string(),
  intent: z.string().describe('What the user appeared to be doing, inferred from the recording.'),
  source: z.object({ sessionId: z.string(), eventCount: z.number().int().nonnegative(), startUrl: z.string(), finalUrl: z.string() }),
  inputs: z.array(CapabilityInput),
  steps: z.array(ToolStep),
  stepEvidence: z.array(z.object({ stepIndex: z.number().int().nonnegative(), eventSeqs: z.array(z.number().int().nonnegative()) })),
  preconditions: z.array(z.string()),
  expectedOutcome: z.string(),
  sideEffectClass: z.enum(['read', 'write', 'consequential']),
  authRequirement: z.enum(['none', 'session']),
  requiresApproval: z.boolean(),
  replayable: z.boolean().describe('False when a step depends on a value that was not kept, such as a credential.'),
  reasons: z.array(z.string()),
  evidence: z.array(EvidenceRef),
});
export type WorkflowDefinitionRecord = z.infer<typeof WorkflowDefinitionRecord>;

export const WorkflowDefinitionData = z.object({
  workflows: z.array(WorkflowDefinitionRecord),
  stats: z.object({
    recordings: z.number().int().nonnegative(),
    workflows: z.number().int().nonnegative(),
    replayable: z.number().int().nonnegative(),
    requiringApproval: z.number().int().nonnegative(),
  }),
});
export type WorkflowDefinitionData = z.infer<typeof WorkflowDefinitionData>;

export const WorkflowDefinition = defineArtifact('WorkflowDefinition', WorkflowDefinitionData);
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
