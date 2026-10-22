import { z } from 'zod';
import type { Capability, WebsiteModelData } from '../schemas/websiteModel.js';
import { ToolStep, type ToolSpec } from '../schemas/toolDefinition.js';
import { shortHash } from '../core/ids.js';

/** A tool from a capability whose mechanics carry a declarative program the model harness built from its browsing session (D27). */
export function generateProgramTool(cap: Capability, model: WebsiteModelData, options: { pageLoadTimeoutMs: number; settleTimeoutMs: number }): ToolSpec | null {
  const m = cap.mechanics;
  if (!m.program?.length) return null;
  const parsed = z.array(ToolStep).min(1).safeParse(m.program);
  if (!parsed.success) return null;
  const program = parsed.data;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const example: Record<string, unknown> = {};
  for (const i of cap.inputs) {
    properties[i.name] = { type: i.type, ...(i.description ? { description: i.description } : {}), ...(i.enum?.length ? { enum: i.enum } : {}), ...(i.type === 'string' && i.required ? { minLength: 1 } : {}) };
    if (i.required) required.push(i.name);
    if (i.example !== undefined) example[i.name] = i.type === 'integer' ? Number(i.example) : i.example;
    else if (i.required) example[i.name] = i.type === 'integer' ? 1 : 'test';
  }
  return {
    toolId: `tool-${shortHash(`${model.site.origin}|${cap.capabilityId}|program`, 12)}`,
    name: cap.name,
    version: '1.0.0',
    title: cap.title,
    description: `${cap.description} Replays the steps the model harness browsed and validated.`,
    capabilityId: cap.capabilityId,
    ...(cap.entity ? { entity: cap.entity } : {}),
    sideEffectClass: 'read',
    idempotent: true,
    authRequirement: 'none',
    transport: 'browser',
    timeoutMs: options.pageLoadTimeoutMs + options.settleTimeoutMs * Math.max(2, program.length) + 5_000,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: m.outputSchema ?? { type: 'object', properties: { results: { type: 'array' }, count: { type: 'integer' }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'] },
    preconditions: [
      { kind: 'scope', detail: `target stays within ${model.site.origin} and its same-site hosts` },
      { kind: 'no-auth', detail: 'no session required' },
      { kind: 'page-reachable', detail: `${m.navigateUrl ?? cap.pageUrl} responds without a bot challenge` },
    ],
    program,
    expectedOutcome: cap.expectedOutcome,
    errorCases: [
      { code: 'INPUT_INVALID', when: 'inputs do not match the input schema' },
      { code: 'OUT_OF_SCOPE', when: 'the navigation target is outside the allowed hosts' },
      { code: 'LOCATOR_MISSING', when: 'a control the program clicks or fills is no longer on the page' },
      { code: 'BLOCKED', when: 'the site answered with a bot challenge or rate limit' },
      { code: 'TIMEOUT', when: 'the page did not load or settle within the timeout' },
      { code: 'SITE_CHANGED', when: 'an expected navigation or assertion did not happen; the site may have changed' },
      { code: 'OUTPUT_INVALID', when: 'extracted data did not match the output schema' },
    ],
    examples: [{ inputs: example, note: 'values the model harness used while browsing' }],
    evidence: cap.evidence,
    status: 'draft',
  };
}
