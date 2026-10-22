import { describe, expect, it } from 'vitest';
import { judgeRuns } from '../src/stages/stage10-validate.js';
import type { ToolSpec } from '../src/schemas/toolDefinition.js';
import type { ToolRunResult } from '../src/schemas/validationReport.js';

const tool = {
  toolId: 't',
  name: 'list_items',
  timeoutMs: 10_000,
  outputSchema: { type: 'object', properties: { results: { type: 'array' }, count: { type: 'integer' }, pageUrl: { type: 'string' } }, required: ['results', 'count', 'pageUrl'] },
} as unknown as ToolSpec;

function run(urls: string[], ok = true): ToolRunResult {
  return { runId: `r-${Math.random()}`, startedAt: new Date().toISOString(), durationMs: 100, ok, steps: [], ...(ok ? { output: { results: urls.map((u) => ({ title: u, url: u })), count: urls.length, pageUrl: 'https://a.test/list' } } : { errorCode: 'SITE_CHANGED' as const, errorMessage: 'boom' }) };
}

describe('judgeRuns', () => {
  it('validates when runs agree up to ordering', () => {
    const v = judgeRuns(tool, {}, [run(['a', 'b', 'c']), run(['c', 'a', 'b'])]);
    expect(v.verdict).toBe('validated');
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });
  it('fails when counts differ or overlap is small', () => {
    expect(judgeRuns(tool, {}, [run(['a', 'b', 'c']), run(['a', 'b'])]).failureReasons[0]).toMatch(/^stable-across-runs/);
    expect(judgeRuns(tool, {}, [run(['a', 'b', 'c', 'd']), run(['e', 'f', 'g', 'h'])]).failureReasons[0]).toMatch(/^stable-across-runs/);
  });
  it('fails on empty results and on failed runs, naming the error code', () => {
    const empty = judgeRuns(tool, {}, [run([]), run([])]);
    expect(empty.verdict).toBe('failed');
    expect(empty.failureReasons.some((r) => r.startsWith('output-nonempty'))).toBe(true);
    const failed = judgeRuns(tool, {}, [run(['a']), run([], false)]);
    expect(failed.failureReasons[0]).toContain('SITE_CHANGED');
  });
});
