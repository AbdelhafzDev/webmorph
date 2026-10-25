/**
 * Compare two benchmark labels site by site: node --import tsx scripts/bench/compare.mts <before-label> <after-label>
 * Prints a Markdown table of per-site means and their deltas; the runner's JSON files are the input.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Scorecard } from './run.mts';

const [before, after] = process.argv.slice(2);
if (!before || !after) throw new Error('usage: compare.mts <before-label> <after-label>');
const load = async (label: string) => JSON.parse(await readFile(resolve(`bench/results/${label}.json`), 'utf8')) as { cards: Scorecard[] };
const a = await load(before);
const b = await load(after);
const sites = Array.from(new Set([...a.cards, ...b.cards].map((c) => c.site))).sort();

interface Means { runs: number; covered: number; validated: number; http: number; turns: number; tokens: number; cached: number; wall: number; required: number; mainFields: number; mainFilled: number; structured: number }
const mean = (cards: Scorecard[]): Means => {
  const n = Math.max(1, cards.length);
  const sum = (f: (c: Scorecard) => number) => cards.reduce((s, c) => s + f(c), 0);
  return {
    runs: cards.length,
    covered: sum((c) => (c.mainTask.covered ? 1 : 0)),
    validated: sum((c) => c.tools.validated) / n,
    http: sum((c) => c.tools.httpValidated) / n,
    turns: sum((c) => c.agent?.turns ?? 0) / n,
    tokens: sum((c) => (c.agent ? c.agent.inputTokens + c.agent.outputTokens : 0)) / n,
    cached: sum((c) => c.agent?.cacheReadTokens ?? 0) / n,
    wall: sum((c) => c.wallMs / 1000) / n,
    required: sum((c) => c.mainTask.requiredInputs?.length ?? 0) / n,
    mainFields: sum((c) => c.mainTask.fields?.fields ?? 0) / n,
    mainFilled: sum((c) => c.mainTask.fields?.filled ?? 0) / n,
    structured: sum((c) => (c.fieldQuality ? c.fieldQuality.structured / Math.max(1, c.fieldQuality.tools) : 0)) / n,
  };
};
const fmt = (v: number, unit: '' | 'k' | 's' = '') => (unit === 'k' ? `${Math.round(v / 1000)}k` : unit === 's' ? `${Math.round(v)} s` : `${Math.round(v * 10) / 10}`);
const delta = (x: number, y: number, unit: '' | 'k' | 's' = '', lowerIsBetter = false) => {
  if (!x && !y) return '';
  const d = y - x;
  const pct = x ? Math.round((d / x) * 100) : 0;
  const sign = d > 0 ? '+' : '';
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `${sign}${fmt(d, unit)}${x ? ` (${sign}${pct}%)` : ''}${d === 0 ? '' : better ? ' better' : ' worse'}`;
};

const lines = [`# ${before} → ${after}`, '', '| Site | Metric | Before | After | Delta |', '|---|---|---|---|---|'];
for (const site of sites) {
  const x = mean(a.cards.filter((c) => c.site === site));
  const y = mean(b.cards.filter((c) => c.site === site));
  const rows: Array<[string, string, string, string]> = [
    ['main task covered', `${x.covered}/${x.runs}`, `${y.covered}/${y.runs}`, delta(x.covered / Math.max(1, x.runs), y.covered / Math.max(1, y.runs))],
    ['required inputs of that tool', fmt(x.required), fmt(y.required), delta(x.required, y.required, '', true)],
    ['main task fields', fmt(x.mainFields), fmt(y.mainFields), delta(x.mainFields, y.mainFields)],
    ['main task fields filled', `${Math.round(x.mainFilled * 100)}%`, `${Math.round(y.mainFilled * 100)}%`, delta(x.mainFilled, y.mainFilled)],
    ['structured tools share', `${Math.round(x.structured * 100)}%`, `${Math.round(y.structured * 100)}%`, delta(x.structured, y.structured)],
    ['validated tools (mean)', fmt(x.validated), fmt(y.validated), delta(x.validated, y.validated)],
    ['of which HTTP', fmt(x.http), fmt(y.http), delta(x.http, y.http)],
    ['harness turns', fmt(x.turns), fmt(y.turns), delta(x.turns, y.turns, '', true)],
    ['uncached tokens (in + out)', fmt(x.tokens, 'k'), fmt(y.tokens, 'k'), delta(x.tokens, y.tokens, 'k', true)],
    ['cache reads', fmt(x.cached, 'k'), fmt(y.cached, 'k'), delta(x.cached, y.cached, 'k', true)],
    ['wall time', fmt(x.wall, 's'), fmt(y.wall, 's'), delta(x.wall, y.wall, 's', true)],
  ];
  rows.forEach(([metric, bx, by, d], i) => lines.push(`| ${i === 0 ? site : ''} | ${metric} | ${bx} | ${by} | ${d} |`));
}
process.stdout.write(`${lines.join('\n')}\n`);
