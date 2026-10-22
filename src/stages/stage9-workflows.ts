import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StageDefinition } from '../core/job.js';
import { shortHash } from '../core/ids.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { RecordedEvent, RecordingSession } from '../schemas/recording.js';
import { WorkflowDefinition, WORKFLOW_DEFINITION_VERSION, type WorkflowDefinitionData, type WorkflowDefinitionRecord } from '../schemas/workflowDefinition.js';
import type { ToolStep } from '../schemas/toolDefinition.js';
import type { CapabilityInput } from '../schemas/websiteModel.js';
import { preferredLocator } from '../browser/locators.js';
import { snake } from '../model/naming.js';
import { makeEnvelope, refTo, type DiscoveryInput } from './shared.js';

const SENSITIVE_FIELD = /^(password|email|tel|file)$/;
const SEARCH_FIELD = /^(q|query|s|search|term|keyword|keywords)$/i;

/** Reconstruct one workflow from a recording. Pure, so it can be unit-tested. */
export function reconstructWorkflow(session: RecordingSession, events: RecordedEvent[], settleTimeoutMs: number): WorkflowDefinitionRecord | null {
  const actions = events.filter((e) => e.type !== 'navigation');
  if (actions.length === 0) return null;
  const steps: ToolStep[] = [];
  const stepEvidence: WorkflowDefinitionRecord['stepEvidence'] = [];
  const inputs: CapabilityInput[] = [];
  const reasons: string[] = [];
  let sideEffectClass: WorkflowDefinitionRecord['sideEffectClass'] = 'read';
  let authRequirement: WorkflowDefinitionRecord['authRequirement'] = 'none';
  let replayable = true;
  let requiresApproval = false;
  let searched = false;
  let resultChoices = 0;
  const usedNames = new Set<string>();
  const push = (step: ToolStep, seqs: number[]) => {
    steps.push(step);
    stepEvidence.push({ stepIndex: steps.length - 1, eventSeqs: seqs });
  };
  const inputName = (e: RecordedEvent): string => {
    const base = snake(e.target?.name ?? e.target?.attributes.name ?? e.target?.attributes.placeholder ?? `field_${e.seq}`) || `field_${e.seq}`;
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}_${i++}`;
    usedNames.add(name);
    return name;
  };

  const first = events.find((e) => e.type === 'navigation');
  push({ op: 'navigate', url: first?.navigation?.to ?? session.startUrl }, first ? [first.seq] : []);
  let lastFilledLocator: ToolStep | undefined;
  const fillByLocator = new Map<string, number>(); // locator value -> step index, to merge repeated edits

  const consumed = new Set<number>();
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (consumed.has(e.seq)) continue;
    // The browser's implicit submission (Enter in a field) also fires a click on the default button and a submit event.
    const implicit: RecordedEvent[] = [];
    if (e.type === 'key') {
      for (const x of events.slice(i + 1)) {
        if ((x.type === 'click' && x.target?.isSubmit && x.target.formAction === e.target?.formAction) || x.type === 'submit') implicit.push(x);
        else break;
      }
    }
    for (const x of implicit) consumed.add(x.seq);
    const next = events.slice(i + 1).find((x) => !consumed.has(x.seq));
    const navFollows = next?.type === 'navigation' && next.navigation?.to !== e.pageUrl;
    const locator = e.target ? preferredLocator(e.target.locators) : undefined;

    if (e.type === 'navigation') {
      // A navigation not produced by the previous action: the person typed a URL or used history.
      const prev = events[i - 1];
      if (!prev || prev.type === 'navigation') {
        if (i > 0 && e.navigation) push({ op: 'navigate', url: e.navigation.to }, [e.seq]);
      }
      continue;
    }
    if (!e.target || !locator) {
      reasons.push(`event ${e.seq} (${e.type}) had no usable locator and was skipped`);
      continue;
    }

    if (e.type === 'input' || e.type === 'select') {
      const fieldType = e.input?.fieldType ?? 'text';
      if (e.input?.redacted && SENSITIVE_FIELD.test(fieldType)) {
        replayable = false;
        if (fieldType === 'password') authRequirement = 'session';
        reasons.push(`value of ${fieldType} field "${e.target.name ?? e.target.attributes.name ?? ''}" was not recorded; the workflow cannot be replayed without it`);
        continue;
      }
      const name = inputName(e);
      const input: CapabilityInput = {
        name,
        type: e.input?.valueKind === 'number' ? 'number' : 'string',
        required: true,
        source: 'form-field',
        ...(e.target.attributes.name ? { param: e.target.attributes.name } : {}),
        ...(e.input?.value !== undefined ? { example: e.input.value } : e.input?.optionLabel ? { example: e.input.optionLabel } : {}),
        description: e.target.name ? `${e.target.name}` : undefined,
      };
      if (e.input?.redacted) reasons.push(`value of "${name}" was not kept; replay uses a placeholder`);
      const key = `${locator.strategy}|${locator.value}`;
      const existing = fillByLocator.get(key);
      if (existing !== undefined) {
        // The person edited the same field again: keep the final value.
        const prevInput = inputs.find((x) => x.name === (steps[existing] as { valueFrom?: string }).valueFrom);
        if (prevInput && input.example !== undefined) prevInput.example = input.example;
        usedNames.delete(name);
        stepEvidence[existing]!.eventSeqs.push(e.seq);
        continue;
      }
      inputs.push(input);
      push(e.type === 'select' ? { op: 'select', locator, valueFrom: name } : { op: 'fill', locator, valueFrom: name }, [e.seq]);
      fillByLocator.set(key, steps.length - 1);
      lastFilledLocator = steps[steps.length - 1];
      if (SEARCH_FIELD.test(e.target.attributes.name ?? '') || e.target.role === 'searchbox') searched = true;
      continue;
    }

    if (e.type === 'key') {
      push({ op: 'press', locator, key: e.key ?? 'Enter' }, [e.seq, ...implicit.map((x) => x.seq)]);
      if (navFollows) push({ op: 'wait', for: 'navigation', timeoutMs: settleTimeoutMs * 3 }, [next!.seq]);
      if (e.target.formMethod === 'post' || implicit.some((x) => x.target?.formMethod === 'post')) {
        sideEffectClass = sideEffectClass === 'read' ? 'write' : sideEffectClass;
        requiresApproval = true;
      }
      continue;
    }

    if (e.type === 'submit') {
      const prev = events[i - 1];
      if (prev?.type === 'key' || prev?.type === 'click') continue; // already represented by the action that submitted
      if (lastFilledLocator && 'locator' in lastFilledLocator) {
        push({ op: 'press', locator: lastFilledLocator.locator, key: 'Enter' }, [e.seq]);
        if (navFollows) push({ op: 'wait', for: 'navigation', timeoutMs: settleTimeoutMs * 3 }, [next!.seq]);
      }
      if (e.target.formMethod === 'post') {
        sideEffectClass = sideEffectClass === 'read' ? 'write' : sideEffectClass;
        requiresApproval = true;
      }
      continue;
    }

    if (e.type === 'click') {
      if (e.target.tag === 'label' || (e.target.tag === 'input' && /^(text|search|email|password|tel|url|number)$/.test(e.target.attributes.type ?? 'text'))) continue; // focusing a field is not a step
      const rc = e.target.resultContext;
      if (e.target.tag === 'a' && rc && rc.siblingCount >= 2 && !e.target.consequential) {
        // One of several similar links: let the caller choose the result instead of pinning this one.
        const suffix = resultChoices === 0 ? '' : `_${resultChoices + 1}`;
        resultChoices += 1;
        const titleInput = `result_title${suffix}`;
        const indexInput = `result_index${suffix}`;
        usedNames.add(titleInput);
        usedNames.add(indexInput);
        inputs.push({ name: titleInput, type: 'string', required: false, source: 'url-param', description: `Title of the result to open (substring match); defaults to the first result. Recorded: "${e.target.name ?? e.target.text ?? ''}"`, ...(e.target.name ? { example: e.target.name } : {}) });
        inputs.push({ name: indexInput, type: 'integer', required: false, source: 'url-param', description: '1-based position of the result to open when no title is given' });
        push({ op: 'click-result', hrefPattern: `^${rc.pathPattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{x\}/g, '[^/?#]+')}/?$`, titleFrom: titleInput, indexFrom: indexInput, scope: 'main' }, [e.seq]);
        if (navFollows) push({ op: 'wait', for: 'navigation', timeoutMs: settleTimeoutMs * 3 }, [next!.seq]);
        reasons.push(`clicked one of ${rc.siblingCount} similar links (${rc.pathPattern}); the result is a parameter`);
        continue;
      }
      push({ op: 'click', locator }, [e.seq]);
      if (navFollows) push({ op: 'wait', for: 'navigation', timeoutMs: settleTimeoutMs * 3 }, [next!.seq]);
      if (e.target.consequential) {
        sideEffectClass = e.target.isSubmit && e.target.formMethod === 'post' ? (sideEffectClass === 'consequential' ? sideEffectClass : 'write') : 'consequential';
        requiresApproval = true;
        reasons.push(`clicked a consequential control: "${e.target.name ?? e.target.text ?? e.target.tag}"`);
      }
    }
  }

  const lastNav = [...events].reverse().find((e) => e.type === 'navigation');
  const finalUrl = lastNav?.navigation?.to ?? events[events.length - 1]?.after?.url ?? session.startUrl;
  const finalTitle = lastNav?.navigation?.title ?? events[events.length - 1]?.after?.title;
  push({ op: 'wait', for: 'dom-stable', timeoutMs: settleTimeoutMs }, []);
  push({ op: 'extract', extractor: { kind: 'page-fields', fields: { title: { source: 'title' }, heading: { source: 'h1' }, text: { source: 'main-text', maxChars: 2000 }, url: { source: 'url' } } } }, []);

  const startPath = new URL(session.startUrl).pathname;
  const intent = searched ? `Search from ${startPath} and open a result` : `Recorded workflow starting at ${startPath}${finalTitle ? ` ending on "${finalTitle}"` : ''}`;
  const name = `workflow_${snake(searched ? 'search_and_open' : finalTitle ?? new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? 'recorded')}`.slice(0, 60) || 'workflow_recorded';
  return {
    workflowId: `wf-${shortHash(session.sessionId, 10)}`,
    name,
    title: searched ? 'Search and open a result' : `Recorded: ${finalTitle ?? 'workflow'}`,
    intent,
    source: { sessionId: session.sessionId, eventCount: events.length, startUrl: session.startUrl, finalUrl },
    inputs,
    steps,
    stepEvidence,
    preconditions: [`${session.startUrl} is reachable`, ...(authRequirement === 'session' ? ['a signed-in session'] : [])],
    expectedOutcome: finalTitle ? `Ends on a page titled "${finalTitle}" (${finalUrl})` : `Ends on ${finalUrl}`,
    sideEffectClass,
    authRequirement,
    requiresApproval,
    replayable,
    reasons,
    evidence: [{ artifactType: 'RecordingSession', refId: session.sessionId, note: `${events.length} recorded events` }],
  };
}

/** Stage 9: workflows from recorded sessions. Observed actions become steps; nothing is inferred beyond the intent label. */
export const stage9Workflows: StageDefinition<DiscoveryInput> = {
  id: 'stage9-workflows',
  produces: ['WorkflowDefinition'],
  requires: ['stage0-scope'],
  optional: true,

  async run(ctx) {
    const manifest = await ctx.artifact('SiteManifest', SiteManifest);
    const sessions = await ctx.store.listRecordings(ctx.siteId);
    const workflows: WorkflowDefinitionRecord[] = [];
    const names = new Set<string>();
    for (const sessionId of sessions) {
      const dir = ctx.store.recordingDir(ctx.siteId, sessionId);
      let session: RecordingSession;
      let events: RecordedEvent[];
      try {
        session = RecordingSession.parse(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')));
        events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => RecordedEvent.parse(JSON.parse(l)));
      } catch (err) {
        ctx.logger.warn(`workflows: skipping ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (session.status !== 'completed') continue;
      const wf = reconstructWorkflow(session, events, manifest.data.budget.settleTimeoutMs);
      if (!wf) continue;
      let name = wf.name;
      let i = 2;
      while (names.has(name)) name = `${wf.name}_${i++}`;
      names.add(name);
      workflows.push({ ...wf, name });
      ctx.logger.info(`workflow ${name}: ${wf.steps.length} steps, ${wf.inputs.length} inputs, ${wf.sideEffectClass}${wf.replayable ? '' : ', not replayable'}`);
    }
    const data: WorkflowDefinitionData = {
      workflows,
      stats: { recordings: sessions.length, workflows: workflows.length, replayable: workflows.filter((w) => w.replayable).length, requiringApproval: workflows.filter((w) => w.requiresApproval).length },
    };
    return [WorkflowDefinition.parse({ ...makeEnvelope({ type: 'WorkflowDefinition', schemaVersion: WORKFLOW_DEFINITION_VERSION, siteId: ctx.siteId, jobId: ctx.jobId, stage: 'stage9-workflows', sources: [refTo(manifest)], now: ctx.now }), data })];
  },
};
