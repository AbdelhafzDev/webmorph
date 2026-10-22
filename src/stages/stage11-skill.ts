import { fileURLToPath } from 'node:url';
import type { StageDefinition } from '../core/job.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { WebsiteModel } from '../schemas/websiteModel.js';
import { ToolDefinition } from '../schemas/toolDefinition.js';
import { ValidationReport } from '../schemas/validationReport.js';
import { SkillDefinition, SKILL_DEFINITION_VERSION } from '../schemas/skillDefinition.js';
import { createModelClient } from '../model/provider.js';
import { generateSkill } from '../model/skill.js';
import type { ModelOptions } from './stage8-model.js';
import { makeEnvelope, refTo, type DiscoveryInput } from './shared.js';

/** Where the CLI lives relative to this module, for the MCP configuration the skill ships with. */
export function cliPath(): string {
  try {
    return fileURLToPath(new URL('../cli.js', import.meta.url));
  } catch {
    return 'dist/cli.js';
  }
}

/**
 * Stage 11: the skill (Layer 3). A site's validated, read-only tools composed with guidance an agent
 * loads as one unit. The model writes the guidance when available; every statement is grounded in the
 * tools and the validation report, and schemas and examples come from them directly (D26).
 */
export const stage11Skill: StageDefinition<DiscoveryInput & { model?: ModelOptions }> = {
  id: 'stage11-skill',
  produces: ['SkillDefinition'],
  requires: ['stage10-validate'],
  optional: true,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const model = await ctx.artifact('WebsiteModel', WebsiteModel);
    const definition = await ctx.artifact('ToolDefinition', ToolDefinition);
    const report = await ctx.artifact('ValidationReport', ValidationReport);
    const validated = new Set(report.data.tools.filter((t) => t.verdict === 'validated').map((t) => t.toolId));
    const tools = definition.data.tools.filter((t) => validated.has(t.toolId) && t.sideEffectClass === 'read' && t.authRequirement === 'none');
    // HTTP tools first, like the MCP listing.
    tools.sort((a, b) => Number(b.transport === 'http') - Number(a.transport === 'http') || a.name.localeCompare(b.name));
    const opts = ctx.input.model ?? {};
    const client = opts.enabled === false ? undefined : opts.client ?? createModelClient({ provider: opts.provider, modelId: opts.modelId });
    const data = await generateSkill(
      {
        siteId: ctx.siteId,
        model: model.data,
        tools,
        validation: report.data,
        mcp: { command: 'node', args: [cliPath(), 'serve', ctx.siteId, '--out', ctx.store.rootDir], note: 'Publish the tools first (`webmorph publish <siteId>`); the MCP server serves published tools only.' },
      },
      client,
    );
    ctx.logger.info(`skill: ${data.name} with ${data.stats.tools} tool(s) (${data.stats.httpTools} HTTP), ${data.stats.handoffs} hand-off(s), guidance by ${data.generation.method}${data.generation.rejected.length ? `, ${data.generation.rejected.length} statement(s) rejected` : ''}${data.generation.error ? `; model error: ${data.generation.error}` : ''}`);
    return [SkillDefinition.parse({ ...makeEnvelope({ type: 'SkillDefinition', schemaVersion: SKILL_DEFINITION_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage11-skill', sources: [refTo(manifest), refTo(model), refTo(definition), refTo(report)], now: ctx.now, method: data.generation.method === 'model' ? 'model-assisted' : 'deterministic' }), data })];
  },
};
