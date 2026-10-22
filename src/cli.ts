#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discover, PHASE1_STAGES, PHASE3_STAGES, BrowserRuntime, executeTool, scopeFromManifest, ToolRegistry, ToolExecutor, createMcpServer, serveStdio, Recorder, stage0Scope, siteIdFromOrigin, normalizeUrl, originOf, FETCH_NORMALIZE, StudioServer } from './index.js';
import { FileArtifactStore } from './core/store.js';
import { readFile } from 'node:fs/promises';
import { stderrLogger } from './core/job.js';
import { exportJsonSchemas } from './schemas/index.js';
import { CrawlReport, PageTemplates, URLInventory, InspectionPlan, PageModel, ElementInventory, InteractionEvidence, WebsiteModel, ToolDefinition, ValidationReport, SiteManifest, DocumentationIndex, ApiCandidates, RecordingSession, WorkflowDefinition, SkillDefinition } from './schemas/index.js';
import { credentialRefOf, parseApiCredentialSpec, parseApiCredentialsFile, type ApiCredential, type ApiCredentialRef } from './schemas/siteConfig.js';
import { errorMessage } from './core/errors.js';
import { WEBMORPH_VERSION } from './version.js';

function int(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('Expected a non-negative integer.');
  return n;
}

const collect = (v: string, prev: string[]) => [...prev, v];

/** Credentials from --api-credential specs and an optional JSON file. Error messages never echo a value. */
async function loadCredentialOptions(specs: string[], file?: string): Promise<ApiCredential[]> {
  const out: ApiCredential[] = [];
  for (const spec of specs) {
    try {
      out.push(parseApiCredentialSpec(spec));
    } catch (err) {
      throw new InvalidArgumentError(`--api-credential: ${errorMessage(err)}`);
    }
  }
  if (file) {
    try {
      out.push(...parseApiCredentialsFile(await readFile(resolve(file), 'utf8')));
    } catch (err) {
      throw new InvalidArgumentError(`--api-credentials-file: ${errorMessage(err)}`);
    }
  }
  return out;
}

function printCredentialRefs(refs: ApiCredentialRef[]): void {
  if (!refs.length) {
    process.stdout.write('no credentials configured\n');
    return;
  }
  for (const r of refs) process.stdout.write(`${r.name.padEnd(44)} ${r.header} -> ${r.host}\n`);
}

const program = new Command();
program.name('webmorph').description('Turn authorized websites into inspectable capabilities for AI agents.').version(WEBMORPH_VERSION);

program
  .command('discover')
  .description('Run deterministic discovery (scope, sitemap, static crawl) against a website.')
  .argument('<url>', 'start URL, including http:// or https://')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--max-pages <n>', 'maximum pages to fetch', int, 50)
  .option('--max-depth <n>', 'maximum link depth from the start URL', int, 3)
  .option('--max-requests <n>', 'request budget per stage', int, 300)
  .option('--concurrency <n>', 'concurrent requests', int, 4)
  .option('--delay-ms <n>', 'minimum delay between requests to the same host', int, 500)
  .option('--timeout-ms <n>', 'per-request timeout', int, 15000)
  .option('--allow-host <host>', 'additional hostname in scope (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--ignore-robots', 'do not honor robots.txt (only for sites you own)', false)
  .option('--allow-private', 'allow localhost and private-network targets (test fixtures only)', false)
  .option('--user-agent <ua>', 'override the User-Agent header')
  .option('--resume <jobId>', 'resume a previous job for this site')
  .option('--no-browser', 'stop after the static crawl; no Playwright stages')
  .option('--no-interactions', 'inspect pages but run no interaction probes')
  .option('--inspect-pages <n>', 'pages to open in the browser', int, 15)
  .option('--max-probes <n>', 'interaction probes across the site', int, 30)
  .option('--probes-per-page <n>', 'interaction probes per page', int, 6)
  .option('--headed', 'show the browser (debugging)', false)
  .option('--allow-write-probes', 'permit probes that submit non-sensitive POST search or filter forms', false)
  .option('--no-model', 'build the website model from evidence only; no Claude call')
  .option('--model-id <id>', 'Claude model for the harness, planning and the skill', 'claude-opus-5-5')
  .option('--no-harness', 'one-shot enrichment instead of the stage 8 harness loop (D26)')
  .option('--agent-turns <n>', 'model turns in the stage 8 harness loop', int, 24)
  .option('--agent-fetches <n>', 'pages and JSON endpoints the harness may read over HTTP', int, 20)
  .option('--agent-inspections <n>', 'pages the harness may open in the browser', int, 6)
  .option('--agent-proposals <n>', 'capability proposals the harness may submit for validation', int, 12)
  .option('--no-validate', 'generate tools but skip replay validation')
  .option('--validation-runs <n>', 'replays per tool during validation', int, 2)
  .option('--api-credential <spec>', 'operator-configured credential for a keyed public API, as [name@]host:header=value (repeatable); stored only in the site config', collect, [] as string[])
  .option('--api-credentials-file <path>', 'JSON file {"apiCredentials":[{"name","host","header","value"}]} of such credentials')
  .option('--json', 'print the summary as JSON', false)
  .option('-v, --verbose', 'log every fetched page', false)
  .action(async (url: string, opts) => {
    const logger = stderrLogger(opts.verbose);
    const started = Date.now();
    try {
      const apiCredentials = await loadCredentialOptions(opts.apiCredential, opts.apiCredentialsFile);
      const result = await discover({
        startUrl: url,
        outDir: resolve(opts.out),
        allowedHosts: opts.allowHost,
        allowPrivate: opts.allowPrivate,
        respectRobots: !opts.ignoreRobots,
        userAgent: opts.userAgent,
        resumeJobId: opts.resume,
        ...(apiCredentials.length ? { apiCredentials } : {}),
        ...(opts.browser === false ? { stages: PHASE1_STAGES } : opts.validate === false ? { stages: PHASE3_STAGES.filter((s) => s.id !== 'stage10-validate') } : {}),
        browser: { interactions: opts.interactions !== false, headed: opts.headed, allowWriteProbes: opts.allowWriteProbes },
        model: { enabled: opts.model !== false, modelId: opts.modelId, harness: opts.harness !== false },
        budget: {
          maxAgentTurns: opts.agentTurns,
          maxAgentFetches: opts.agentFetches,
          maxAgentInspections: opts.agentInspections,
          maxAgentProposals: opts.agentProposals,
          maxPagesToInspect: opts.inspectPages,
          maxProbesTotal: opts.maxProbes,
          maxProbesPerPage: opts.probesPerPage,
          validationRuns: opts.validationRuns,
          maxPages: opts.maxPages,
          maxDepth: opts.maxDepth,
          maxRequests: opts.maxRequests,
          maxConcurrency: opts.concurrency,
          minDelayMs: opts.delayMs,
          requestTimeoutMs: opts.timeoutMs,
        },
        logger,
      });

      const { store, siteId, jobId, job } = result;
      const summary: Record<string, unknown> = {
        siteId,
        jobId,
        status: job.status,
        jobDir: result.jobDir,
        durationMs: Date.now() - started,
        stages: Object.fromEntries(job.stages.map((s) => [s.id, s.status])),
      };
      if (await store.hasArtifact(siteId, jobId, 'URLInventory')) {
        const inv = await store.readArtifact(siteId, jobId, 'URLInventory', URLInventory);
        summary['urlInventory'] = { ...inv.data.stats, robots: inv.data.robots.status, sitemaps: inv.data.sitemaps.filter((s) => s.status === 'ok').length };
      }
      if (await store.hasArtifact(siteId, jobId, 'CrawlReport')) {
        const report = await store.readArtifact(siteId, jobId, 'CrawlReport', CrawlReport);
        summary['crawl'] = {
          pagesAttempted: report.data.budget.pagesAttempted,
          ok: report.data.counts['ok'] ?? 0,
          counts: report.data.counts,
          siteRenderMode: report.data.siteRenderMode,
          siteBlocked: report.data.siteBlocked,
          warnings: report.data.warnings,
        };
      }
      if (await store.hasArtifact(siteId, jobId, 'PageTemplates')) {
        const templates = await store.readArtifact(siteId, jobId, 'PageTemplates', PageTemplates);
        summary['templates'] = templates.data.templates.map((t) => ({ pattern: t.urlPattern, kind: t.kind, pages: t.pageCount, cohesion: t.cohesion }));
      }
      if (await store.hasArtifact(siteId, jobId, 'InspectionPlan')) {
        const plan = await store.readArtifact(siteId, jobId, 'InspectionPlan', InspectionPlan);
        summary['plan'] = { strategy: plan.data.strategy, ...plan.data.stats };
      }
      if (await store.hasArtifact(siteId, jobId, 'PageModel')) {
        const model = await store.readArtifact(siteId, jobId, 'PageModel', PageModel);
        const inv = await store.readArtifact(siteId, jobId, 'ElementInventory', ElementInventory);
        summary['inspection'] = { ...model.data.stats, elements: inv.data.stats.elements, withUniqueLocator: inv.data.stats.withUniqueLocator, forms: inv.data.forms.length, byCategory: inv.data.stats.byCategory };
      }
      if (await store.hasArtifact(siteId, jobId, 'InteractionEvidence')) {
        const ev = await store.readArtifact(siteId, jobId, 'InteractionEvidence', InteractionEvidence);
        summary['probes'] = ev.data.stats;
      }
      if (await store.hasArtifact(siteId, jobId, 'DocumentationIndex')) {
        const di = await store.readArtifact(siteId, jobId, 'DocumentationIndex', DocumentationIndex);
        summary['docs'] = { ...di.data.stats, found: di.data.sources.filter((x) => !['missing', 'error', 'skipped'].includes(x.kind)).map((x) => `${x.kind} ${x.url}`), apis: di.data.apis.map((a) => `${a.title ?? a.specUrl}: ${a.operations.length} ops`) };
      }
      if (await store.hasArtifact(siteId, jobId, 'ApiCandidates')) {
        const ac = await store.readArtifact(siteId, jobId, 'ApiCandidates', ApiCandidates);
        // Same-site candidates first; third-party traffic (feature flags, ads, analytics) is shown last and tagged.
        const ranked = [...ac.data.candidates].sort((a, b) => Number(b.inScope || b.sameSite) - Number(a.inScope || a.sameSite) || b.confidence - a.confidence || b.count - a.count);
        summary['apiCandidates'] = { ...ac.data.stats, top: ranked.slice(0, 8).map((c) => `${c.method} ${c.urlTemplate}${c.queryParams.length ? `?${c.queryParams.join('&')}` : ''} x${c.count}${c.documentedOperationId ? ` (${c.documentedOperationId})` : ''}${c.credentialed ? ' [credentialed]' : ''}${c.configuredCredential ? ` [credential: ${c.configuredCredential}]` : ''}${c.inScope || c.sameSite ? '' : ' [third-party]'}`) };
      }
      if (await store.hasArtifact(siteId, jobId, 'WorkflowDefinition')) {
        const wd = await store.readArtifact(siteId, jobId, 'WorkflowDefinition', WorkflowDefinition);
        summary['workflows'] = { ...wd.data.stats, items: wd.data.workflows.map((w) => `${w.name} (${w.steps.length} steps, ${w.sideEffectClass}${w.replayable ? '' : ', not replayable'})`) };
      }
      if (await store.hasArtifact(siteId, jobId, 'WebsiteModel')) {
        const wm = await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel);
        summary['model'] = { purpose: wm.data.site.purpose.statement, entities: wm.data.entities.map((e) => e.name), capabilities: wm.data.capabilities.map((c) => `${c.name} (${c.status})`), facts: wm.data.facts.length, hypotheses: wm.data.hypotheses.length, enrichment: wm.data.enrichment.applied ? wm.data.enrichment.model : `off${wm.data.enrichment.error ? `: ${wm.data.enrichment.error}` : ''}` };
      }
      if (await store.hasArtifact(siteId, jobId, 'ToolDefinition')) {
        const td = await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition);
        summary['tools'] = td.data.tools.map((t) => ({ name: t.name, sideEffect: t.sideEffectClass, transport: t.transport ?? 'browser', inputs: Object.keys((t.inputSchema['properties'] as Record<string, unknown>) ?? {}) }));
        summary['apiGaps'] = td.data.apiGaps.map((g) => `${g.name}: ${g.reason}; ${g.detail}`);
      }
      if (await store.hasArtifact(siteId, jobId, 'ValidationReport')) {
        const vr = await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport);
        summary['validation'] = { ...vr.data.stats, tools: vr.data.tools.map((t) => ({ name: t.name, verdict: t.verdict, reason: t.failureReasons[0] })) };
      }
      if (await store.hasArtifact(siteId, jobId, 'WebsiteModel')) {
        const wm = await store.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel);
        if (wm.data.agent) summary['harness'] = { model: wm.data.agent.model, turns: wm.data.agent.turns, toolCalls: wm.data.agent.toolCalls.length, accepted: wm.data.agent.proposals.accepted, rejected: wm.data.agent.proposals.rejected.length, tokens: wm.data.agent.inputTokens + wm.data.agent.outputTokens, stoppedBecause: wm.data.agent.stoppedBecause, error: wm.data.agent.error };
      }
      if (await store.hasArtifact(siteId, jobId, 'SkillDefinition')) {
        const sk = await store.readArtifact(siteId, jobId, 'SkillDefinition', SkillDefinition);
        summary['skill'] = { name: sk.data.name, ...sk.data.stats, guidance: sk.data.generation.method, rejected: sk.data.generation.rejected.length, error: sk.data.generation.error };
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      } else {
        printSummary(summary);
      }
      process.exitCode = job.status === 'completed' ? 0 : 1;
    } catch (err) {
      logger.warn(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

const schemas = program.command('schemas').description('Artifact schema utilities.');
schemas
  .command('export')
  .description('Write JSON Schema files for every implemented artifact type.')
  .argument('[dir]', 'output directory', 'schemas')
  .action(async (dir: string) => {
    const out = resolve(dir);
    await mkdir(out, { recursive: true });
    const all = exportJsonSchemas();
    for (const [type, schema] of Object.entries(all)) {
      await writeFile(join(out, `${type}.schema.json`), JSON.stringify(schema, null, 2) + '\n');
    }
    process.stdout.write(`wrote ${Object.keys(all).length} schema(s) to ${out}\n`);
  });

function printSummary(s: Record<string, unknown>): void {
  const lines: string[] = [];
  lines.push(`job ${s['jobId']} for site ${s['siteId']}: ${s['status']}`);
  lines.push(`artifacts: ${s['jobDir']}`);
  lines.push(`stages: ${Object.entries(s['stages'] as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const inv = s['urlInventory'] as Record<string, unknown> | undefined;
  if (inv) lines.push(`urls: ${inv['inScope']} in scope (${inv['fromSitemap']} from sitemap, ${inv['robotsDisallowed']} robots-disallowed), robots.txt ${inv['robots']}, ${inv['sitemaps']} sitemap(s) parsed`);
  const crawl = s['crawl'] as Record<string, unknown> | undefined;
  if (crawl) {
    lines.push(`crawl: ${crawl['pagesAttempted']} fetched, ${crawl['ok']} ok, render mode ${crawl['siteRenderMode']}${crawl['siteBlocked'] ? ', SITE BLOCKED' : ''}`);
    const counts = crawl['counts'] as Record<string, number>;
    lines.push(`outcomes: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    for (const w of crawl['warnings'] as string[]) lines.push(`warning: ${w}`);
  }
  const plan = s['plan'] as Record<string, unknown> | undefined;
  if (plan) lines.push(`plan: ${plan['strategy']}, ${plan['selected']} of ${plan['candidates']} pages selected, ${plan['templatesCovered']}/${plan['templatesTotal']} templates covered`);
  const insp = s['inspection'] as Record<string, unknown> | undefined;
  if (insp) {
    lines.push(`inspection: ${insp['ok']}/${insp['inspected']} pages ok, ${insp['elements']} elements (${insp['withUniqueLocator']} uniquely locatable), ${insp['forms']} forms, ${insp['clientRenderedPages']} client-rendered`);
    const cats = insp['byCategory'] as Record<string, number>;
    lines.push(`categories: ${Object.entries(cats).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  const probes = s['probes'] as Record<string, unknown> | undefined;
  if (probes) {
    const out = probes['byOutcome'] as Record<string, number>;
    lines.push(`probes: ${probes['executed']} run (${Object.entries(out).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}), ${probes['skippedByPolicy']} skipped by policy, ${probes['skippedByBudget']} by budget`);
  }
  const docs = s['docs'] as Record<string, unknown> | undefined;
  if (docs) {
    lines.push(`docs: ${(docs['found'] as string[]).length} source(s) in ${docs['requests']} request(s), ${docs['operations']} documented operations (${docs['readOperationsWithoutAuth']} read-only without auth)`);
    for (const f of (docs['found'] as string[]).slice(0, 6)) lines.push(`  ${f}`);
  }
  const api = s['apiCandidates'] as Record<string, unknown> | undefined;
  if (api) {
    lines.push(`api candidates: ${api['total']} observed, ${api['documented']} documented, ${api['readOnlyPublic']} read-only public`);
    for (const c of api['top'] as string[]) lines.push(`  ${c}`);
  }
  const wf = s['workflows'] as Record<string, unknown> | undefined;
  if (wf && (wf['recordings'] as number) > 0) {
    lines.push(`workflows: ${wf['workflows']} from ${wf['recordings']} recording(s), ${wf['replayable']} replayable, ${wf['requiringApproval']} requiring approval`);
    for (const w of wf['items'] as string[]) lines.push(`  ${w}`);
  }
  const model = s['model'] as Record<string, unknown> | undefined;
  if (model) {
    lines.push(`model: ${model['purpose']}`);
    lines.push(`entities: ${(model['entities'] as string[]).join(', ') || 'none'}  facts: ${model['facts']}  hypotheses: ${model['hypotheses']}  enrichment: ${model['enrichment']}`);
    lines.push(`capabilities: ${(model['capabilities'] as string[]).join(', ') || 'none'}`);
  }
  const tools = s['tools'] as Array<Record<string, unknown>> | undefined;
  if (tools) lines.push(`tools: ${tools.map((t) => `${t['name']}(${(t['inputs'] as string[]).join(', ')})${t['transport'] === 'http' ? '' : ' [browser]'}`).join('  ') || 'none'}`);
  const apiGaps = s['apiGaps'] as string[] | undefined;
  if (apiGaps?.length) {
    lines.push(`no HTTP route: ${apiGaps.length} capabilit${apiGaps.length === 1 ? 'y' : 'ies'}`);
    for (const g of apiGaps.slice(0, 10)) lines.push(`  ${g}`);
  }
  const validation = s['validation'] as Record<string, unknown> | undefined;
  if (validation) {
    lines.push(`validation: ${validation['validated']} validated, ${validation['failed']} failed`);
    for (const t of validation['tools'] as Array<Record<string, unknown>>) lines.push(`  ${String(t['verdict']).padEnd(10)} ${t['name']}${t['reason'] ? `  ${t['reason']}` : ''}`);
  }
  const harness = s['harness'] as Record<string, unknown> | undefined;
  if (harness) lines.push(`harness: ${harness['model']}, ${harness['turns']} turn(s), ${harness['toolCalls']} tool call(s), ${(harness['accepted'] as string[]).length} proposal(s) kept (${(harness['accepted'] as string[]).join(', ') || 'none'}), ${harness['rejected']} rejected, ${harness['tokens']} tokens${harness['stoppedBecause'] ? `; ${harness['stoppedBecause']}` : ''}${harness['error'] ? `; error: ${harness['error']}` : ''}`);
  const skill = s['skill'] as Record<string, unknown> | undefined;
  if (skill) lines.push(`skill: ${skill['name']} with ${skill['tools']} tool(s) (${skill['httpTools']} HTTP), ${skill['handoffs']} hand-off(s), guidance by ${skill['guidance']}${skill['error'] ? `; model error: ${skill['error']}` : ''}  (export: webmorph skill <siteId>)`);
  const templates = s['templates'] as Array<Record<string, unknown>> | undefined;
  if (templates && templates.length) {
    lines.push('templates:');
    for (const t of templates.slice(0, 25)) lines.push(`  ${String(t['kind']).padEnd(14)} ${String(t['pages']).padStart(4)} page(s)  cohesion ${t['cohesion']}  ${t['pattern']}`);
    if (templates.length > 25) lines.push(`  ... ${templates.length - 25} more`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

program
  .command('run-tool')
  .description('Execute a generated tool from a job against the live site and print the result as JSON.')
  .argument('<siteId>', 'site id (see the discover summary)')
  .argument('<toolName>', 'tool name, e.g. search_products')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--job <jobId>', 'job id; defaults to the latest job for the site')
  .option('--input <json>', 'tool inputs as a JSON object', '{}')
  .option('--headed', 'show the browser', false)
  .action(async (siteId: string, toolName: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const jobId: string | undefined = opts.job ?? JSON.parse(await readFile(join(store.siteDir(siteId), 'site.json'), 'utf8')).latestJobId;
    if (!jobId) {
      process.stderr.write(`no jobs found for site ${siteId}\n`);
      process.exitCode = 1;
      return;
    }
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    const definition = await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition);
    const tool = definition.data.tools.find((t) => t.name === toolName);
    if (!tool) {
      process.stderr.write(`tool ${toolName} not found; available: ${definition.data.tools.map((t) => t.name).join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const scope = scopeFromManifest(manifest.data);
    const credentials = (await store.readSiteConfig(siteId)).apiCredentials;
    const runtime = new BrowserRuntime({ scope, allowPrivate: manifest.data.scope.allowPrivateNetwork, userAgent: manifest.data.scope.userAgent, headed: opts.headed });
    await runtime.launch();
    try {
      const result = await executeTool(runtime, tool, JSON.parse(opts.input) as Record<string, unknown>, { scope, pageLoadTimeoutMs: manifest.data.budget.pageLoadTimeoutMs, settleTimeoutMs: manifest.data.budget.settleTimeoutMs, credentials });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      await runtime.close();
    }
  });

async function latestJobId(store: FileArtifactStore, siteId: string): Promise<string> {
  const record = JSON.parse(await readFile(join(store.siteDir(siteId), 'site.json'), 'utf8')) as { latestJobId: string };
  return record.latestJobId;
}

program
  .command('tools')
  .description('List a site\'s generated tools with their validation verdict and registry status.')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--job <jobId>', 'job to read; defaults to the latest')
  .option('--json', 'print JSON', false)
  .action(async (siteId: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const jobId: string = opts.job ?? (await latestJobId(store, siteId));
    const definition = await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition);
    const report = (await store.hasArtifact(siteId, jobId, 'ValidationReport')) ? await store.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport) : undefined;
    const registry = await new ToolRegistry(store, siteId).load();
    const rows = definition.data.tools.map((t) => {
      const v = report?.data.tools.find((x) => x.toolId === t.toolId);
      const r = registry.tools[t.name];
      return { name: t.name, sideEffect: t.sideEffectClass, inputs: Object.keys((t.inputSchema['properties'] as Record<string, unknown>) ?? {}), validation: v?.verdict ?? 'not run', reason: v?.failureReasons[0], registry: r ? `${r.status} (job ${r.pinned.jobId}, ${r.calls.total} calls)` : 'not published' };
    });
    if (opts.json) process.stdout.write(JSON.stringify({ jobId, tools: rows }, null, 2) + '\n');
    else {
      process.stdout.write(`job ${jobId}\n`);
      for (const r of rows) process.stdout.write(`  ${r.name.padEnd(28)} ${r.validation.padEnd(10)} ${r.registry.padEnd(40)} inputs: ${r.inputs.join(', ')}${r.reason ? `  (${r.reason})` : ''}\n`);
    }
  });

program
  .command('publish')
  .description('Approve validated tools for agents: copy them into the site registry pinned to their job.')
  .argument('<siteId>')
  .argument('[names...]', 'tool names; omit for all validated tools')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--job <jobId>', 'job to publish from; defaults to the latest')
  .option('--force', 'publish tools that did not pass validation', false)
  .action(async (siteId: string, names: string[], opts) => {
    const registry = new ToolRegistry(new FileArtifactStore(resolve(opts.out)), siteId);
    const result = await registry.publish({ jobId: opts.job, names, force: opts.force });
    process.stdout.write(`published from job ${result.jobId}: ${result.published.join(', ') || 'nothing'}\n`);
    for (const s of result.skipped) process.stdout.write(`skipped ${s.name}: ${s.reason}\n`);
    process.exitCode = result.published.length ? 0 : 1;
  });

for (const [cmd, status, verb] of [
  ['disable', 'disabled', 'Disable a published tool so agents can no longer call it.'],
  ['enable', 'published', 'Re-enable a disabled or degraded tool without revalidating it.'],
] as const) {
  program
    .command(cmd)
    .description(verb)
    .argument('<siteId>')
    .argument('<name>')
    .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
    .option('--reason <text>', 'recorded in the tool history', `operator ${cmd}`)
    .action(async (siteId: string, name: string, opts) => {
      const registry = new ToolRegistry(new FileArtifactStore(resolve(opts.out)), siteId);
      const entry = await registry.setStatus(name, status, opts.reason);
      process.stdout.write(`${name}: ${entry.status}\n`);
    });
}

program
  .command('skill')
  .description('Export a site\'s skill (SKILL.md, the validated tool contracts and the MCP configuration) from a job.')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--job <jobId>', 'job to read; defaults to the latest')
  .option('--dir <path>', 'directory to write into; defaults to <out>/sites/<siteId>/skills/<name>')
  .option('--json', 'print the SkillDefinition data instead of writing files', false)
  .action(async (siteId: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const jobId: string = opts.job ?? (await latestJobId(store, siteId));
    const skill = await store.readArtifact(siteId, jobId, 'SkillDefinition', SkillDefinition);
    if (opts.json) {
      process.stdout.write(JSON.stringify(skill.data, null, 2) + '\n');
      return;
    }
    const definition = await store.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition);
    const names = new Set(skill.data.tools.map((t) => t.name));
    const dir = resolve(opts.dir ?? join(store.siteDir(siteId), 'skills', skill.data.name));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), skill.data.markdown);
    await writeFile(join(dir, 'tools.json'), JSON.stringify(skill.data.tools.map((t) => definition.data.tools.find((x) => x.name === t.name)).filter(Boolean), null, 2) + '\n');
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [skill.data.name]: { command: skill.data.mcp.command, args: skill.data.mcp.args } } }, null, 2) + '\n');
    process.stdout.write(`wrote ${join(dir, 'SKILL.md')}, tools.json (${names.size} tool(s)) and mcp.json\n`);
  });

const credentialsCommand = program.command('credentials').description('Operator-configured credentials for keyed public APIs. Values live only in the site config (config.json); nothing here prints them.');
credentialsCommand
  .command('list')
  .description('Show configured credentials by name, header and host.')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--json', 'print JSON', false)
  .action(async (siteId: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const refs = (await store.readSiteConfig(siteId)).apiCredentials.map(credentialRefOf);
    if (opts.json) process.stdout.write(JSON.stringify(refs, null, 2) + '\n');
    else printCredentialRefs(refs);
  });
credentialsCommand
  .command('set')
  .description('Add or replace credentials: [name@]host:header=value specs, or --file. Re-run discover afterwards so keyed endpoints can become HTTP tools.')
  .argument('<siteId>')
  .argument('[specs...]', 'credential specs, e.g. search-api.example.com:authorization="Bearer …"')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--file <path>', 'JSON file {"apiCredentials":[{"name","host","header","value"}]}')
  .action(async (siteId: string, specs: string[], opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const parsed = await loadCredentialOptions(specs, opts.file);
    if (!parsed.length) throw new InvalidArgumentError('give at least one spec or --file');
    const config = await store.upsertApiCredentials(siteId, parsed);
    process.stdout.write(`set ${parsed.map((c) => c.name).join(', ')} in ${store.siteConfigPath(siteId)}\n`);
    printCredentialRefs(config.apiCredentials.map(credentialRefOf));
  });
credentialsCommand
  .command('remove')
  .description('Remove a configured credential by name.')
  .argument('<siteId>')
  .argument('<name>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .action(async (siteId: string, name: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const removed = await store.removeApiCredential(siteId, name);
    process.stdout.write(removed ? `removed ${name}\n` : `no credential named ${name}\n`);
    process.exitCode = removed ? 0 : 1;
  });

program
  .command('revalidate')
  .description('Replay published and degraded tools against the live site and update their status.')
  .argument('<siteId>')
  .argument('[names...]')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .action(async (siteId: string, names: string[], opts) => {
    const executor = new ToolExecutor({ store: new FileArtifactStore(resolve(opts.out)), siteId, logger: stderrLogger(false) });
    try {
      const results = await executor.revalidate(names);
      for (const r of results) process.stdout.write(`${r.name.padEnd(28)} ${r.verdict.padEnd(10)} -> ${r.status}${r.reason ? `  ${r.reason}` : ''}\n`);
      process.exitCode = results.every((r) => r.verdict === 'validated') ? 0 : 1;
    } finally {
      await executor.close();
    }
  });

program
  .command('call')
  .description('Call a published tool through the executor (policy, concurrency and statistics apply) and print the result.')
  .argument('<siteId>')
  .argument('<name>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--input <json>', 'tool inputs as a JSON object', '{}')
  .action(async (siteId: string, name: string, opts) => {
    const executor = new ToolExecutor({ store: new FileArtifactStore(resolve(opts.out)), siteId, logger: stderrLogger(false) });
    try {
      const result = await executor.call(name, JSON.parse(opts.input) as Record<string, unknown>);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      await executor.close();
    }
  });

program
  .command('serve')
  .description('Serve a site\'s published tools to an MCP client over stdio.')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--concurrency <n>', 'concurrent tool calls', int, 2)
  .action(async (siteId: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const registry = await new ToolRegistry(store, siteId).load();
    const executor = new ToolExecutor({ store, siteId, logger: stderrLogger(false), maxConcurrency: opts.concurrency });
    const server = createMcpServer({ executor, siteId, origin: registry.origin });
    const shutdown = async () => {
      await server.close().catch(() => {});
      await executor.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    process.stderr.write(`webmorph mcp: serving ${Object.values(registry.tools).filter((t) => t.status === 'published').length} published tool(s) for ${registry.origin} over stdio\n`);
    await serveStdio(server);
  });

program
  .command('record')
  .description('Open a browser WebMorph owns and record a workflow you perform by hand. Close the window or press Ctrl+C to finish.')
  .argument('<siteOrUrl>', 'site id from a previous discover, or a URL')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--start <url>', 'page to open first; defaults to the site start URL')
  .option('--keep-values', 'keep typed values of non-sensitive fields so the workflow can replay with them', false)
  .option('--screenshots', 'store a screenshot after every event', false)
  .option('--max-minutes <n>', 'stop automatically after this long', int, 15)
  .option('--headless', 'no window (scripted use)', false)
  .option('--allow-private', 'allow localhost and private-network targets', false)
  .action(async (siteOrUrl: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    const logger = stderrLogger(false);
    let siteId = siteOrUrl;
    if (/^https?:\/\//i.test(siteOrUrl)) {
      const normalized = normalizeUrl(siteOrUrl, undefined, FETCH_NORMALIZE);
      if (!normalized) throw new Error(`not a valid URL: ${siteOrUrl}`);
      siteId = siteIdFromOrigin(originOf(normalized));
      const hasSite = (await store.listJobs(siteId)).length > 0;
      if (!hasSite) {
        logger.info('no site record yet; creating a scope manifest first');
        await discover({ stages: [stage0Scope], startUrl: normalized, outDir: resolve(opts.out), allowPrivate: opts.allowPrivate, logger });
      }
    }
    const jobId = await latestJobId(store, siteId);
    const manifest = await store.readArtifact(siteId, jobId, 'SiteManifest', SiteManifest);
    const recorder = new Recorder({ store, siteId, manifest, startUrl: opts.start ?? manifest.data.normalizedStartUrl, keepValues: opts.keepValues, screenshots: opts.screenshots, headed: !opts.headless, maxMinutes: opts.maxMinutes, logger });
    const { sessionId } = await recorder.start();
    process.stderr.write(`recording ${sessionId}: perform the workflow in the browser window, then close it (or press Ctrl+C) to finish\n`);
    const onSignal = () => void recorder.stop('interrupted').then(() => process.exit(0));
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    await recorder.waitForClose();
    const session = await recorder.stop('window closed');
    process.stdout.write(JSON.stringify({ sessionId: session.sessionId, status: session.status, events: session.eventCount, pages: session.pagesVisited, dir: recorder.dir }, null, 2) + '\n');
    process.stdout.write(`next: node dist/cli.js discover ${manifest.data.startUrl} --out ${opts.out}   # reconstructs workflows and generates tools\n`);
  });

program
  .command('recordings')
  .description('List recorded sessions for a site.')
  .argument('<siteId>')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .action(async (siteId: string, opts) => {
    const store = new FileArtifactStore(resolve(opts.out));
    for (const id of await store.listRecordings(siteId)) {
      try {
        const session = RecordingSession.parse(JSON.parse(await readFile(join(store.recordingDir(siteId, id), 'session.json'), 'utf8')));
        process.stdout.write(`${id}  ${session.status.padEnd(10)} ${String(session.eventCount).padStart(4)} events  ${session.pagesVisited.length} pages  started ${session.startedAt}\n`);
      } catch {
        process.stdout.write(`${id}  (unreadable)\n`);
      }
    }
  });

program
  .command('studio')
  .description('Open the local review UI: evidence, model, tools, publishing, recordings.')
  .option('-o, --out <dir>', 'artifact store directory', '.webmorph')
  .option('--port <n>', 'port to listen on (loopback only)', int, 4848)
  .action(async (opts) => {
    const studio = new StudioServer({ store: new FileArtifactStore(resolve(opts.out)), port: opts.port, logger: stderrLogger(false) });
    const url = await studio.start();
    process.stderr.write(`webmorph studio: ${url}  (Ctrl+C to stop)\n`);
    const shutdown = async () => {
      await studio.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    await new Promise(() => {});
  });

program.parseAsync(process.argv);
