import { z } from 'zod';
import { defineArtifact } from './common.js';
import { EvidenceRef } from './websiteModel.js';

export const SKILL_DEFINITION_VERSION = '1.0.0';

export const SkillToolEntry = z.object({
  name: z.string(),
  title: z.string(),
  transport: z.enum(['http', 'browser']),
  when: z.string().describe('When an agent should call this tool, in the site\'s vocabulary.'),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), description: z.string().optional(), example: z.string().optional() })),
  notes: z.string().optional().describe('Caveats observed during validation or stated by the model and grounded in the tool.'),
});
export type SkillToolEntry = z.infer<typeof SkillToolEntry>;

export const SkillHandoff = z.object({
  from: z.string().describe('Tool whose output feeds the next step.'),
  output: z.string().describe('Which part of the output, e.g. results[].url.'),
  to: z.string().describe('Tool that takes it.'),
  input: z.string().describe('Input of the target tool.'),
  note: z.string().optional(),
});
export type SkillHandoff = z.infer<typeof SkillHandoff>;

export const SkillExample = z.object({
  tool: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  summary: z.string().describe('What the validation run returned, summarized by code (count, first titles), never invented.'),
  source: z.literal('validation-run'),
});
export type SkillExample = z.infer<typeof SkillExample>;

/**
 * A skill: a site's validated tools composed with guidance an agent loads as one unit (Layer 3).
 * The markdown is rendered from the structured fields, which are grounded in the tools and the
 * validation report; the model may write guidance, never mechanics or examples.
 */
export const SkillDefinitionData = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).describe('Slug, also the directory name of the rendered skill.'),
  title: z.string(),
  description: z.string().describe('One or two sentences for the skill catalog.'),
  origin: z.string(),
  overview: z.string().describe('Markdown paragraphs: what the site is and what the tools cover.'),
  tools: z.array(SkillToolEntry),
  handoffs: z.array(SkillHandoff),
  errorGuide: z.array(z.object({ code: z.string(), meaning: z.string() })),
  tips: z.array(z.string()),
  examples: z.array(SkillExample),
  mcp: z.object({ command: z.string(), args: z.array(z.string()), note: z.string() }),
  markdown: z.string().describe('The rendered SKILL.md, frontmatter included.'),
  generation: z.object({
    method: z.enum(['model', 'template']),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    rejected: z.array(z.string()).describe('Model statements dropped because they named unknown tools or inputs, or read like instructions.'),
    error: z.string().optional(),
  }),
  evidence: z.array(EvidenceRef),
  stats: z.object({ tools: z.number().int().nonnegative(), httpTools: z.number().int().nonnegative(), handoffs: z.number().int().nonnegative(), examples: z.number().int().nonnegative() }),
});
export type SkillDefinitionData = z.infer<typeof SkillDefinitionData>;

export const SkillDefinition = defineArtifact('SkillDefinition', SkillDefinitionData);
export type SkillDefinition = z.infer<typeof SkillDefinition>;
