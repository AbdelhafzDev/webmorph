import type { StageDefinition } from '../core/job.js';
import { runPool } from '../core/pool.js';
import { shortHash } from '../core/ids.js';
import { BrowserRuntime } from '../browser/runtime.js';
import { executeProbe, planProbes, NEVER_CLICK_PATTERNS, type ProbePlan } from '../browser/probes.js';
import { NEVER_FILL_TYPES } from '../html/forms.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { InspectionPlan } from '../schemas/inspectionPlan.js';
import { PageModel } from '../schemas/pageModel.js';
import { ElementInventory } from '../schemas/elementInventory.js';
import {
  InteractionEvidence,
  INTERACTION_EVIDENCE_VERSION,
  StateTransition,
  STATE_TRANSITION_VERSION,
  type InteractionEvidenceData,
  type ProbeRecord,
  type StateTransitionData,
  type StateTransitionRecord,
} from '../schemas/interactionEvidence.js';
import { makeEnvelope, refTo, scopeFromManifest, type DiscoveryInput } from './shared.js';

/**
 * Stage 6: targeted, bounded interactions on inspected pages. Each probe runs
 * in a fresh browser context, waits on state rather than sleeps, records the
 * before and after states, and is discarded. Read-only by policy.
 */
export const stage6Interact: StageDefinition<DiscoveryInput> = {
  id: 'stage6-interact',
  produces: ['InteractionEvidence', 'StateTransition'],
  requires: ['stage5-inspect'],
  optional: true,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const plan = await ctx.artifact('InspectionPlan', InspectionPlan);
    const pageModel = await ctx.artifact('PageModel', PageModel);
    const inventory = await ctx.artifact('ElementInventory', ElementInventory);
    const { budget, scope: scopeData } = manifest.data;
    const scope = scopeFromManifest(manifest.data);
    const browserOpts = ctx.input.browser ?? {};
    const policy = { allowWriteProbes: browserOpts.allowWriteProbes ?? false };
    const enabled = browserOpts.interactions !== false;

    const allowedUrls = new Set(plan.data.entries.filter((e) => e.interactionsAllowed).map((e) => e.url));
    const plans: ProbePlan[] = [];
    let skippedByPolicy = 0;
    let skippedByBudget = 0;
    let deduplicated = 0;
    let planned = 0;
    // Site-wide controls (header search, global filters) appear on every page; probe each once.
    const seen = new Set<string>();
    if (enabled) {
      for (const page of pageModel.data.pages) {
        if (page.outcome !== 'ok' || !allowedUrls.has(page.url)) continue;
        const elements = inventory.data.elements.filter((e) => e.pageUrl === page.finalUrl);
        const forms = inventory.data.forms.filter((f) => f.pageUrl === page.finalUrl);
        const { probes, skippedByPolicy: skipped } = planProbes(page, elements, forms, policy, budget.maxProbesPerPage);
        skippedByPolicy += skipped;
        planned += probes.length;
        for (const probe of probes) {
          const key = `${probe.kind}|${probe.action.locator.strategy}|${probe.action.locator.value}|${probe.form?.action ?? ''}`;
          if (seen.has(key)) {
            deduplicated += 1;
            continue;
          }
          seen.add(key);
          if (plans.length >= budget.maxProbesTotal) {
            skippedByBudget += 1;
            continue;
          }
          plans.push(probe);
        }
      }
    }

    const records: ProbeRecord[] = [];
    if (plans.length > 0) {
      const runtime = new BrowserRuntime({
        scope,
        allowPrivate: scopeData.allowPrivateNetwork,
        userAgent: scopeData.userAgent,
        headed: browserOpts.headed,
        blockHeavyResources: browserOpts.blockHeavyResources,
        allowWrites: policy.allowWriteProbes,
        executablePath: browserOpts.executablePath,
        channel: browserOpts.channel,
        resolver: ctx.input.resolver,
        maxNetworkRecords: budget.maxNetworkRecords,
        maxJsonPeekBytes: budget.maxJsonPeekBytes,
        now: ctx.now,
      });
      const networkSink = async (records: import('../schemas/networkEvidence.js').NetworkRecord[]) => {
        for (const r of records) await ctx.store.appendEvidence(ctx.siteId, ctx.jobId, 'network', r);
      };
      await runtime.launch();
      try {
        const results = await runPool(
          plans,
          budget.browserConcurrency,
          async (probe, i) => {
            const probeId = `probe-${shortHash(`${ctx.jobId}|${probe.pageUrl}|${probe.element.elementId}|${probe.kind}`, 10)}`;
            const record = await executeProbe(runtime, probe, { pageLoadTimeoutMs: budget.pageLoadTimeoutMs, settleTimeoutMs: budget.settleTimeoutMs }, scope, probeId, networkSink);
            await ctx.store.appendEvidence(ctx.siteId, ctx.jobId, 'interactions', record);
            ctx.logger.info(`probe ${i + 1}/${plans.length} ${record.kind} on ${probe.pageUrl}: ${record.outcome}${record.error ? ` (${record.error})` : ''}`);
            return record;
          },
          ctx.signal,
        );
        records.push(...results.filter((r): r is ProbeRecord => Boolean(r)));
      } finally {
        await runtime.close();
      }
    }

    const transitions: StateTransitionRecord[] = records
      .filter((r) => (r.outcome === 'navigated' || r.outcome === 'changed') && r.before && r.after)
      .map((r) => ({
        transitionId: `tr-${shortHash(r.probeId, 10)}`,
        probeId: r.probeId,
        kind: r.kind,
        from: { url: r.before!.url, stateHash: r.before!.stateHash },
        to: { url: r.after!.url, stateHash: r.after!.stateHash },
        effect: r.outcome === 'navigated' ? 'navigation' : 'in-page-change',
        summary: r.outcome === 'navigated' ? `${r.kind}: ${r.before!.url} -> ${r.after!.url}` : `${r.kind}: in-page change (${r.changes?.textDelta ?? 0} chars, ${r.changes?.interactiveDelta ?? 0} controls)`,
      }));

    const byKind: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    for (const r of records) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    }

    const evidenceData: InteractionEvidenceData = {
      probes: records,
      policy: { allowWriteProbes: policy.allowWriteProbes, neverClickPatterns: NEVER_CLICK_PATTERNS, neverFillTypes: NEVER_FILL_TYPES },
      evidenceLog: 'evidence/interactions.jsonl',
      stats: { planned, executed: records.length, byKind, byOutcome, skippedByPolicy, skippedByBudget, deduplicated },
    };
    const transitionData: StateTransitionData = {
      transitions,
      stats: { total: transitions.length, navigations: transitions.filter((t) => t.effect === 'navigation').length, inPageChanges: transitions.filter((t) => t.effect === 'in-page-change').length },
    };

    const common = { siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage6-interact' as const, now: ctx.now, sources: [refTo(manifest), refTo(plan), refTo(pageModel), refTo(inventory)] };
    const evidence = InteractionEvidence.parse({ ...makeEnvelope({ ...common, type: 'InteractionEvidence', schemaVersion: INTERACTION_EVIDENCE_VERSION }), data: evidenceData });
    const transition = StateTransition.parse({ ...makeEnvelope({ ...common, type: 'StateTransition', schemaVersion: STATE_TRANSITION_VERSION, sources: [...common.sources, refTo(evidence)] }), data: transitionData });
    ctx.logger.info(`interact: ${records.length} probes (${Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}), ${transitions.length} transitions`);
    return [evidence, transition];
  },
};
