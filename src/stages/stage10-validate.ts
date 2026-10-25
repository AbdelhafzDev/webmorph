import type { StageDefinition, Logger } from '../core/job.js';
import { runPool } from '../core/pool.js';
import { BrowserRuntime } from '../browser/runtime.js';
import { executeTool, toolNeedsBrowser, type ExecuteOptions } from '../tools/interpreter.js';
import { validateAgainstSchema } from '../tools/jsonschema.js';
import { hasStructuredData } from '../html/pageData.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { ToolDefinition, type ToolSpec } from '../schemas/toolDefinition.js';
import { ValidationReport, VALIDATION_REPORT_VERSION, type ToolRunResult, type ToolValidation, type ValidationCheck, type ValidationReportData } from '../schemas/validationReport.js';
import { makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

export interface ValidateToolOptions extends ExecuteOptions {
  runs: number;
  logger?: Logger;
}

/** Replay a tool N times with its example inputs and judge the runs. Never throws. */
export async function validateTool(runtime: BrowserRuntime | null, tool: ToolSpec, options: ValidateToolOptions): Promise<ToolValidation> {
  const inputs = tool.examples[0]?.inputs ?? {};
  if (tool.sideEffectClass !== 'read' || tool.authRequirement !== 'none') {
    const why = tool.sideEffectClass !== 'read' ? `not replayed: ${tool.sideEffectClass} side effects` : 'not replayed: requires a session';
    return { toolId: tool.toolId, name: tool.name, inputs, runs: [], checks: [], verdict: 'skipped', statusAfter: 'draft', failureReasons: [why] };
  }
  const runs: ToolRunResult[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    const run = await executeTool(runtime, tool, inputs, options);
    runs.push(run);
    options.logger?.debug(`validate ${tool.name} run ${i + 1}/${options.runs}: ${run.ok ? 'ok' : `${run.errorCode} ${run.errorMessage ?? ''}`}`);
  }
  return judgeRuns(tool, inputs, runs);
}

/** Pure judgement of replay runs. Stability tolerates reordering: same count and at least half the URLs in common. */
export function judgeRuns(tool: ToolSpec, inputs: Record<string, unknown>, runs: ToolRunResult[]): ToolValidation {
  const checks: ValidationCheck[] = [];
  const okRuns = runs.filter((r) => r.ok);
  checks.push({ name: 'runs-succeed', passed: okRuns.length === runs.length, detail: okRuns.length === runs.length ? `${runs.length}/${runs.length} runs succeeded` : runs.filter((r) => !r.ok).map((r) => `${r.errorCode}: ${r.errorMessage ?? ''}`).join('; ') });

  const schemaProblems = okRuns.flatMap((r) => validateAgainstSchema(tool.outputSchema, r.output));
  checks.push({ name: 'output-schema', passed: schemaProblems.length === 0 && okRuns.length > 0, detail: schemaProblems.length ? schemaProblems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join('; ') : okRuns.length ? 'outputs match the output schema' : 'no successful run to check' });

  const nonEmpty = okRuns.every((r) => {
    const out = r.output as Record<string, unknown> | undefined;
    if (!out) return false;
    if (Array.isArray(out['results'])) return (out['results'] as unknown[]).length > 0;
    if (Array.isArray(out['jsonLd']) && 'embedded' in out) {
      return hasStructuredData({ jsonLd: out['jsonLd'] as unknown[], embedded: (out['embedded'] as Record<string, unknown>) ?? {}, og: (out['og'] as Record<string, string>) ?? {}, jsonLdTypes: [], breadcrumbs: [] });
    }
    if ('data' in out) {
      const data = out['data'];
      if (Array.isArray(data)) return data.length > 0;
      return data !== null && typeof data === 'object' && Object.keys(data as object).length > 0;
    }
    return typeof out['title'] === 'string' && out['title'].trim().length > 0;
  });
  const pageData = okRuns.length > 0 && Array.isArray((okRuns[0]!.output as Record<string, unknown>)['jsonLd']);
  checks.push({ name: 'output-nonempty', passed: okRuns.length > 0 && nonEmpty, detail: nonEmpty && okRuns.length ? 'every run produced results' : pageData ? 'the page publishes no structured data (no JSON-LD, embedded JSON or product meta tags)' : 'at least one run produced no results for the example inputs' });

  let stable = okRuns.length > 0;
  let stabilityDetail = okRuns.length ? 'results agree across runs' : 'no successful run to compare';
  if (okRuns.length > 1) {
    const first = okRuns[0]!.output as Record<string, unknown>;
    for (const r of okRuns.slice(1)) {
      const out = r.output as Record<string, unknown>;
      if (Array.isArray(first['results']) && Array.isArray(out['results'])) {
        const a = new Set((first['results'] as Array<{ url?: string }>).map((x) => x.url ?? ''));
        const b = new Set((out['results'] as Array<{ url?: string }>).map((x) => x.url ?? ''));
        const overlap = Array.from(a).filter((u) => b.has(u)).length;
        const union = new Set([...a, ...b]).size;
        const countsAgree = a.size === b.size;
        const share = union === 0 ? 1 : overlap / union;
        if (!countsAgree || share < 0.5) {
          stable = false;
          stabilityDetail = `results differed across runs: ${a.size} vs ${b.size} items, ${Math.round(share * 100)}% in common`;
          break;
        }
      } else if ('data' in first && 'data' in out) {
        const sig = (d: unknown): string => {
          if (Array.isArray(d)) {
            const head = d[0] as Record<string, unknown> | undefined;
            return `array:${d.length}:${head && typeof head === 'object' ? String(head['id'] ?? head['url'] ?? head['slug'] ?? head['name'] ?? '') : ''}`;
          }
          if (d && typeof d === 'object') {
            const o = d as Record<string, unknown>;
            const listKey = Object.keys(o).find((k) => Array.isArray(o[k]));
            return `object:${Object.keys(o).sort().join(',')}:${listKey ? (o[listKey] as unknown[]).length : ''}`;
          }
          return String(d);
        };
        if (sig(first['data']) !== sig(out['data'])) {
          stable = false;
          stabilityDetail = `JSON data differed across runs: ${sig(first['data'])} vs ${sig(out['data'])}`;
          break;
        }
      } else if (String(first['title'] ?? '') !== String(out['title'] ?? '')) {
        stable = false;
        stabilityDetail = `title differed across runs: "${String(first['title'] ?? '')}" vs "${String(out['title'] ?? '')}"`;
        break;
      }
    }
  }
  checks.push({ name: 'stable-across-runs', passed: stable, detail: stabilityDetail });

  const withinTimeout = runs.every((r) => r.durationMs <= tool.timeoutMs);
  checks.push({ name: 'latency-within-timeout', passed: withinTimeout, detail: `max ${Math.max(...runs.map((r) => r.durationMs))}ms of ${tool.timeoutMs}ms allowed` });

  const failureReasons = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  const verdict = failureReasons.length === 0 ? 'validated' : 'failed';
  return { toolId: tool.toolId, name: tool.name, inputs, runs, checks, verdict, statusAfter: verdict === 'validated' ? 'validated' : 'draft', failureReasons };
}

/** Stage 10b: replay every generated tool against the live site and record what held. */
export const stage10Validate: StageDefinition<DiscoveryInput> = {
  id: 'stage10-validate',
  produces: ['ValidationReport'],
  requires: ['stage10-generate'],
  optional: false,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const definition = await ctx.artifact('ToolDefinition', ToolDefinition);
    const { budget, scope: scopeData } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const browserOpts = ctx.input.browser ?? {};
    // Configured credentials come from the mutable site config, never from an artifact; validation replays with them (D23).
    const credentials = (await ctx.store.readSiteConfig(ctx.siteId)).apiCredentials;
    const results: ToolValidation[] = [];

    const anyBrowser = definition.data.tools.some((t) => toolNeedsBrowser(t));
    if (definition.data.tools.length > 0) {
      const runtime = anyBrowser ? new BrowserRuntime({
        scope,
        allowPrivate: scopeData.allowPrivateNetwork,
        userAgent: scopeData.userAgent,
        headed: browserOpts.headed,
        blockHeavyResources: browserOpts.blockHeavyResources,
        executablePath: browserOpts.executablePath,
        channel: browserOpts.channel,
        resolver: ctx.input.resolver,
      }) : null;
      await runtime?.launch();
      try {
        // Tools validate side by side: browser tools bounded by the browser concurrency budget, HTTP tools a little wider.
        const validateOne = async (tool: ToolSpec) => {
          const v = await validateTool(runtime, tool, { scope, pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs, runs: budget.validationRuns, logger: ctx.logger, now: ctx.now, credentials });
          ctx.logger.info(`validate ${tool.name}: ${v.verdict}${v.failureReasons.length ? ` (${v.failureReasons[0]})` : ''}`);
          return v;
        };
        const browserTools = definition.data.tools.filter((t) => toolNeedsBrowser(t));
        const httpTools = definition.data.tools.filter((t) => !toolNeedsBrowser(t));
        const [browserResults, httpResults] = await Promise.all([runPool(browserTools, budget.browserConcurrency, validateOne, ctx.signal), runPool(httpTools, Math.max(budget.browserConcurrency, 4), validateOne, ctx.signal)]);
        const byId = new Map([...browserResults, ...httpResults].filter((v): v is ToolValidation => Boolean(v)).map((v) => [v.toolId, v]));
        for (const tool of definition.data.tools) {
          const v = byId.get(tool.toolId);
          if (v) results.push(v);
        }
      } finally {
        await runtime?.close();
      }
    }

    const byErrorCode: Record<string, number> = {};
    for (const v of results) for (const r of v.runs) if (r.errorCode) byErrorCode[r.errorCode] = (byErrorCode[r.errorCode] ?? 0) + 1;
    const data: ValidationReportData = {
      tools: results,
      runsPerTool: budget.validationRuns,
      stats: { total: results.length, validated: results.filter((v) => v.verdict === 'validated').length, failed: results.filter((v) => v.verdict === 'failed').length, skipped: results.filter((v) => v.verdict === 'skipped').length, byErrorCode },
    };
    return [ValidationReport.parse({ ...makeEnvelope({ type: 'ValidationReport', schemaVersion: VALIDATION_REPORT_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage10-validate', sources: [refTo(manifest), refTo(definition)], now: ctx.now }), data })];
  },
};
