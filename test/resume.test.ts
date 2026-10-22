import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, PHASE1_STAGES, stage0Scope, stage2Sitemap, type DiscoveryInput } from '../src/index.js';
import type { StageDefinition } from '../src/core/job.js';
import { startFixtureSite, type FixtureSite } from './fixtures/server.js';

let site: FixtureSite;
let outDir: string;
beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'webmorph-resume-'));
});
afterAll(async () => {
  await site.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('resume', () => {
  it('re-runs only the failed stage and rejects a different stage list', async () => {
    let failOnce = true;
    const flaky: StageDefinition<DiscoveryInput> = {
      id: 'stage1-docs',
      produces: [],
      requires: ['stage0-scope'],
      optional: false,
      async run() {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated outage');
        }
        return [];
      },
    };
    const stages = [stage0Scope, flaky, stage2Sitemap];
    const base = { startUrl: `${site.baseUrl}/`, outDir, allowPrivate: true, stages, sleep: async () => {}, budget: { minDelayMs: 0 } };

    await expect(discover(base)).rejects.toThrow(/simulated outage/);
    const siteDir = join(outDir, 'sites');
    const { readdir } = await import('node:fs/promises');
    const siteId = (await readdir(siteDir))[0]!;
    const jobId = (await readdir(join(siteDir, siteId, 'jobs')))[0]!;

    await expect(discover({ ...base, resumeJobId: jobId, stages: PHASE1_STAGES })).rejects.toThrow(/Cannot resume/);

    const resumed = await discover({ ...base, resumeJobId: jobId });
    expect(resumed.job.status).toBe('completed');
    expect(resumed.job.stages.map((s) => [s.id, s.status, s.attempts])).toEqual([
      ['stage0-scope', 'completed', 1],
      ['stage1-docs', 'completed', 2],
      ['stage2-sitemap', 'completed', 1],
    ]);
  }, 30_000);
});
