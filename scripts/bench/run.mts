/**
 * Benchmark runner: discovers each site in bench/sites.json several times and scores every run from its artifacts.
 *
 *   node --import tsx scripts/bench/run.mts [--sites sar,haraj] [--runs 2] [--parallel 2] [--label baseline] [--config bench/sites.json]
 *
 * Raw artifacts go to a scratch store (--store, default .webmorph-bench, ignored by git); the committed outputs are
 * bench/results/<label>.json (every run's scorecard) and bench/results/<label>.md (the table).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { discover, SkillDefinition, ToolDefinition, ValidationReport, WebsiteModel } from '../../src/index.js';
import { stderrLogger } from '../../src/core/job.js';
import type { Budget } from '../../src/schemas/siteManifest.js';

try {
  process.loadEnvFile(resolve('.env'));
} catch {
  // no .env: provider keys come from the environment
}

interface SiteSpec {
  id: string;
  startUrl: string;
  allowedHosts?: string[];
  /** Fixture sites on loopback (smoke tests). */
  allowPrivate?: boolean;
  budget?: Partial<Budget>;
  mainTask: { description: string; match: string; inputs: string[] };
}
interface SitesFile {
  defaults: { runs: number; model: { enabled?: boolean; provider?: 'anthropic' | 'openai'; modelId?: string }; budget: Partial<Budget> };
  sites: SiteSpec[];
}

/** How usable a tool's result rows are: how many named fields they carry and how many of those are filled. */
export interface FieldQuality {
  fields: number;
  /** Share of (row, field) cells that hold a value, 0 to 1. */
  filled: number;
  /** Two or more named fields: an agent need not parse a blob. */
  structured: boolean;
}

export function fieldQualityOf(output: unknown): FieldQuality | undefined {
  const o = output as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const data = o['data'];
  const rows = (Array.isArray(o['results']) ? o['results'] : Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data as Record<string, unknown>).find((v) => Array.isArray(v)) : undefined) as unknown[] | undefined;
  const objects = rows?.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !Array.isArray(r)) ?? [];
  if (!objects.length) return undefined;
  const names = Array.from(new Set(objects.flatMap((r) => Object.keys(r))));
  const cells = objects.length * names.length;
  const filledCells = objects.reduce((n, r) => n + names.filter((f) => r[f] !== undefined && r[f] !== null && String(r[f]).trim() !== '').length, 0);
  return { fields: names.length, filled: cells ? filledCells / cells : 0, structured: names.length >= 2 };
}

export interface Scorecard {
  site: string;
  run: number;
  jobId: string;
  status: string;
  wallMs: number;
  tools: { total: number; validated: number; httpValidated: number; browserValidated: number; failed: string[] };
  mainTask: { covered: boolean; tool?: string; transport?: string; requiredInputs?: string[]; fields?: FieldQuality };
  /** Mean over validated tools whose replay returned result rows. */
  fieldQuality?: { tools: number; meanFields: number; meanFilled: number; structured: number };
  apiGaps: Record<string, number>;
  agent?: { turns: number; toolCalls: number; accepted: string[]; rejected: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; finished: boolean; stoppedBecause?: string };
  skill?: { tools: number; httpTools: number; handoffs: number; guidance: string };
  error?: string;
}

const { values } = parseArgs({
  options: {
    sites: { type: 'string' },
    runs: { type: 'string' },
    parallel: { type: 'string', default: '2' },
    label: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    store: { type: 'string', default: '.webmorph-bench' },
    config: { type: 'string', default: 'bench/sites.json' },
    verbose: { type: 'boolean', default: false },
  },
});

const file = JSON.parse(await readFile(resolve(values.config!), 'utf8')) as SitesFile;
const wanted = values.sites ? new Set(values.sites.split(',')) : null;
const sites = file.sites.filter((s) => !wanted || wanted.has(s.id));
if (!sites.length) throw new Error(`no site matches --sites ${values.sites}`);
const runs = Number(values.runs ?? file.defaults.runs);
const parallel = Math.max(1, Number(values.parallel));
const store = resolve(values.store);
await mkdir(store, { recursive: true });

const inputMatches = (name: string, patterns: string[]) => patterns.map((p) => new RegExp(p, 'i')).some((re) => re.test(name));

async function runOnce(site: SiteSpec, run: number): Promise<Scorecard> {
  const started = Date.now();
  const outDir = join(store, site.id, `run-${run}`);
  await mkdir(outDir, { recursive: true });
  const card: Scorecard = { site: site.id, run, jobId: '', status: 'failed', wallMs: 0, tools: { total: 0, validated: 0, httpValidated: 0, browserValidated: 0, failed: [] }, mainTask: { covered: false }, apiGaps: {} };
  try {
    const result = await discover({
      startUrl: site.startUrl,
      outDir,
      allowedHosts: site.allowedHosts ?? [],
      ...(site.allowPrivate ? { allowPrivate: true } : {}),
      logger: stderrLogger(values.verbose),
      model: { enabled: file.defaults.model.enabled !== false, harness: true, ...(file.defaults.model.provider ? { provider: file.defaults.model.provider } : {}), ...(file.defaults.model.modelId ? { modelId: file.defaults.model.modelId } : {}) },
      budget: { ...file.defaults.budget, ...site.budget },
    });
    card.jobId = result.jobId;
    card.status = result.job.status;
    const { store: artifacts, siteId, jobId } = result;
    const tools = (await artifacts.readArtifact(siteId, jobId, 'ToolDefinition', ToolDefinition)).data;
    const report = (await artifacts.readArtifact(siteId, jobId, 'ValidationReport', ValidationReport)).data;
    const model = (await artifacts.readArtifact(siteId, jobId, 'WebsiteModel', WebsiteModel)).data;
    const verdictOf = new Map(report.tools.map((t) => [t.toolId, t.verdict]));
    const validated = tools.tools.filter((t) => verdictOf.get(t.toolId) === 'validated');
    card.tools = {
      total: tools.tools.length,
      validated: validated.length,
      httpValidated: validated.filter((t) => t.transport === 'http').length,
      browserValidated: validated.filter((t) => t.transport !== 'http').length,
      failed: tools.tools.filter((t) => verdictOf.get(t.toolId) !== 'validated').map((t) => t.name),
    };
    for (const gap of tools.apiGaps) card.apiGaps[gap.reason] = (card.apiGaps[gap.reason] ?? 0) + 1;
    const match = new RegExp(site.mainTask.match, 'i');
    // The main task counts as covered by a validated tool whose name, title or description matches and whose inputs cover every expected kind.
    const covering = [...validated.filter((t) => t.transport === 'http'), ...validated.filter((t) => t.transport !== 'http')].find((t) => {
      const text = `${t.name} ${t.title ?? ''} ${t.description ?? ''}`;
      const names = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      return match.test(text) && site.mainTask.inputs.every((patterns) => names.some((n) => inputMatches(n, patterns.split('|').map((p) => p.trim()))));
    });
    const outputOf = (toolId: string) => report.tools.find((t) => t.toolId === toolId)?.runs.find((r) => r.ok)?.output;
    if (covering) {
      const fields = fieldQualityOf(outputOf(covering.toolId));
      card.mainTask = { covered: true, tool: covering.name, transport: covering.transport ?? 'browser', requiredInputs: ((covering.inputSchema as { required?: string[] }).required ?? []).slice(), ...(fields ? { fields } : {}) };
    }
    const qualities = validated.map((t) => fieldQualityOf(outputOf(t.toolId))).filter((q): q is FieldQuality => Boolean(q));
    if (qualities.length) card.fieldQuality = { tools: qualities.length, meanFields: qualities.reduce((n, q) => n + q.fields, 0) / qualities.length, meanFilled: qualities.reduce((n, q) => n + q.filled, 0) / qualities.length, structured: qualities.filter((q) => q.structured).length };
    if (model.agent) {
      const a = model.agent;
      card.agent = { turns: a.turns, toolCalls: a.toolCalls.length, accepted: a.proposals.accepted, rejected: a.proposals.rejected.length, inputTokens: a.inputTokens, outputTokens: a.outputTokens, cacheReadTokens: a.cacheReadTokens ?? 0, finished: a.finished, ...(a.stoppedBecause ? { stoppedBecause: a.stoppedBecause } : {}) };
    }
    try {
      const skill = (await artifacts.readArtifact(siteId, jobId, 'SkillDefinition', SkillDefinition)).data;
      card.skill = { ...skill.stats, guidance: skill.generation.method };
    } catch {
      // no skill artifact
    }
  } catch (err) {
    card.error = err instanceof Error ? err.message : String(err);
  }
  card.wallMs = Date.now() - started;
  process.stderr.write(`bench: ${site.id} run ${run}: ${card.status}, ${card.tools.validated}/${card.tools.total} validated, main task ${card.mainTask.covered ? `covered by ${card.mainTask.tool}` : 'not covered'}, ${Math.round(card.wallMs / 1000)} s\n`);
  return card;
}

// Runs of one site go one after another (a site sees one crawler at a time); sites run in parallel up to --parallel.
const queue = sites.map((site) => async () => {
  const cards: Scorecard[] = [];
  for (let run = 1; run <= runs; run += 1) cards.push(await runOnce(site, run));
  return cards;
});
const cards: Scorecard[] = [];
const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) cards.push(...(await job()));
});
await Promise.all(workers);
cards.sort((a, b) => a.site.localeCompare(b.site) || a.run - b.run);

const label = values.label!;
await mkdir(resolve('bench/results'), { recursive: true });
await writeFile(resolve(`bench/results/${label}.json`), `${JSON.stringify({ label, date: new Date().toISOString(), provider: file.defaults.model.enabled === false ? null : (file.defaults.model.provider ?? 'default'), runs, cards }, null, 2)}\n`);
await writeFile(resolve(`bench/results/${label}.md`), renderSummary(label, sites, cards));
process.stderr.write(`bench: wrote bench/results/${label}.json and .md\n`);

function renderSummary(label: string, sites: SiteSpec[], cards: Scorecard[]): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const lines = [`# Benchmark ${label}`, '', `Provider: ${file.defaults.model.enabled === false ? 'none (deterministic only)' : file.defaults.model.provider ?? 'default'}. ${runs} run(s) per site. Tokens are the harness's: uncached input + output, with prompt-cache reads apart.`, ''];
  lines.push('| Site | Run | Status | Tools validated (HTTP / browser) | Main task | Required inputs | Main task fields (filled) | Structured tools | Agent turns | Tokens (uncached in + out) | Cache reads | Wall |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cards) {
    const main = c.mainTask.covered ? `yes: ${c.mainTask.tool} (${c.mainTask.transport})` : 'no';
    const mf = c.mainTask.fields ? `${c.mainTask.fields.fields} (${Math.round(c.mainTask.fields.filled * 100)}%)` : '';
    const st = c.fieldQuality ? `${c.fieldQuality.structured}/${c.fieldQuality.tools}` : '';
    lines.push(`| ${c.site} | ${c.run} | ${c.status}${c.error ? ` (${c.error.slice(0, 60)})` : ''} | ${c.tools.validated}/${c.tools.total} (${c.tools.httpValidated} / ${c.tools.browserValidated}) | ${main} | ${c.mainTask.requiredInputs?.join(', ') ?? ''} | ${mf} | ${st} | ${c.agent?.turns ?? ''} | ${c.agent ? k(c.agent.inputTokens + c.agent.outputTokens) : ''} | ${c.agent ? k(c.agent.cacheReadTokens) : ''} | ${Math.round(c.wallMs / 1000)} s |`);
  }
  lines.push('', '## Per site', '');
  for (const site of sites) {
    const mine = cards.filter((c) => c.site === site.id);
    const covered = mine.filter((c) => c.mainTask.covered).length;
    const avg = (f: (c: Scorecard) => number) => Math.round(mine.reduce((n, c) => n + f(c), 0) / Math.max(1, mine.length));
    lines.push(`### ${site.id}`, '', `Main task: ${site.mainTask.description}. Covered in ${covered}/${mine.length} run(s). Mean validated tools ${avg((c) => c.tools.validated)} (${avg((c) => c.tools.httpValidated)} HTTP). Mean harness tokens ${k(avg((c) => (c.agent ? c.agent.inputTokens + c.agent.outputTokens : 0)))} uncached, ${k(avg((c) => c.agent?.cacheReadTokens ?? 0))} cached. Mean wall ${avg((c) => c.wallMs / 1000)} s.`, '');
    for (const c of mine) {
      lines.push(`- Run ${c.run}: kept ${c.agent?.accepted.join(', ') || 'nothing'}; ${c.agent?.rejected ?? 0} rejected; ${c.agent?.stoppedBecause ?? ''}${c.tools.failed.length ? `; failed validation: ${c.tools.failed.join(', ')}` : ''}${Object.keys(c.apiGaps).length ? `; API gaps: ${Object.entries(c.apiGaps).map(([r, n]) => `${r} ${n}`).join(', ')}` : ''}.`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
