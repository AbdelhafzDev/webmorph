import type { FileArtifactStore } from '../core/store.js';
import type { Logger } from '../core/job.js';
import { silentLogger } from '../core/job.js';
import { Semaphore } from '../net/ratelimit.js';
import { BrowserRuntime } from '../browser/runtime.js';
import { ScopePolicy } from '../net/scope.js';
import type { Resolver } from '../net/ssrf.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import type { ToolRunResult } from '../schemas/validationReport.js';
import type { PublishedTool } from '../schemas/registry.js';
import { executeTool, toolNeedsBrowser } from '../tools/interpreter.js';
import { validateTool } from '../stages/stage10-validate.js';
import { ToolRegistry } from '../registry/registry.js';

export interface ExecutorOptions {
  store: FileArtifactStore;
  siteId: string;
  logger?: Logger;
  /** Concurrent tool calls against the site. Default 2. */
  maxConcurrency?: number;
  /** Consecutive site-change failures before a tool is degraded. Default 2. */
  degradeAfter?: number;
  headed?: boolean;
  resolver?: Resolver;
  now?: () => Date;
}

export interface CallResult extends ToolRunResult {
  tool: string;
  /** Registry status after the call. */
  status?: PublishedTool['status'];
}

/**
 * Runs published tools for agents. One browser per executor, a fresh context
 * per call, bounded concurrency per site, policy enforced before anything is
 * dialed, and registry statistics updated after every call.
 */
export class ToolExecutor {
  readonly registry: ToolRegistry;
  private runtime?: BrowserRuntime;
  private manifest?: SiteManifest;
  private scope?: ScopePolicy;
  private readonly semaphore: Semaphore;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly options: ExecutorOptions) {
    this.registry = new ToolRegistry(options.store, options.siteId, options.now);
    this.semaphore = new Semaphore(options.maxConcurrency ?? 2);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  async close(): Promise<void> {
    const r = this.runtime;
    this.runtime = undefined;
    await r?.close();
  }

  private async ensureManifest(jobId: string): Promise<{ manifest: SiteManifest; scope: ScopePolicy }> {
    if (!this.manifest) {
      this.manifest = await this.options.store.readArtifact(this.options.siteId, jobId, 'SiteManifest', SiteManifest);
      this.scope = new ScopePolicy(this.manifest.data.scope, { hosts: this.manifest.data.prohibited.hosts, pathPatterns: this.manifest.data.prohibited.pathPatterns });
    }
    return { manifest: this.manifest, scope: this.scope! };
  }

  private async ensureRuntime(jobId: string): Promise<{ runtime: BrowserRuntime; manifest: SiteManifest; scope: ScopePolicy }> {
    if (!this.manifest) {
      this.manifest = await this.options.store.readArtifact(this.options.siteId, jobId, 'SiteManifest', SiteManifest);
      this.scope = new ScopePolicy(this.manifest.data.scope, { hosts: this.manifest.data.prohibited.hosts, pathPatterns: this.manifest.data.prohibited.pathPatterns });
    }
    if (!this.runtime) {
      this.runtime = new BrowserRuntime({
        scope: this.scope!,
        allowPrivate: this.manifest.data.scope.allowPrivateNetwork,
        userAgent: this.manifest.data.scope.userAgent,
        headed: this.options.headed,
        resolver: this.options.resolver,
      });
      await this.runtime.launch();
    }
    return { runtime: this.runtime, manifest: this.manifest, scope: this.scope! };
  }

  /** Read fresh on every call so an operator can add or rotate a credential while the server runs. */
  private async credentials() {
    return (await this.options.store.readSiteConfig(this.options.siteId)).apiCredentials;
  }

  private refusal(name: string, errorCode: 'TOOL_UNAVAILABLE' | 'PERMISSION_DENIED', errorMessage: string, status?: PublishedTool['status']): CallResult {
    return { tool: name, runId: `refused-${Date.now().toString(36)}`, startedAt: this.now().toISOString(), durationMs: 0, ok: false, errorCode, errorMessage, steps: [], ...(status ? { status } : {}) };
  }

  /** Execute a published tool. Never throws for expected failures. */
  async call(name: string, inputs: Record<string, unknown>): Promise<CallResult> {
    const entry = await this.registry.get(name);
    if (!entry) return this.refusal(name, 'TOOL_UNAVAILABLE', `tool "${name}" is not published for this site`);
    if (entry.status === 'disabled') return this.refusal(name, 'TOOL_UNAVAILABLE', `tool "${name}" is disabled by the operator`, entry.status);
    if (entry.status === 'degraded') return this.refusal(name, 'TOOL_UNAVAILABLE', `tool "${name}" is degraded (${entry.calls.lastError ?? 'repeated failures'}); an operator must revalidate it`, entry.status);
    if (entry.tool.sideEffectClass !== 'read') return this.refusal(name, 'PERMISSION_DENIED', `tool "${name}" has side effect class ${entry.tool.sideEffectClass}; only read tools can run without an approval policy`, entry.status);
    if (entry.tool.authRequirement !== 'none') return this.refusal(name, 'PERMISSION_DENIED', `tool "${name}" requires a session, which this adapter does not provide`, entry.status);

    const needsBrowser = toolNeedsBrowser(entry.tool);
    const { manifest, scope } = needsBrowser ? await this.ensureRuntime(entry.pinned.jobId) : await this.ensureManifest(entry.pinned.jobId);
    const runtime = needsBrowser ? this.runtime! : null;
    const credentials = await this.credentials();
    const release = await this.semaphore.acquire();
    const started = Date.now();
    let result: ToolRunResult;
    try {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<ToolRunResult>((resolve) => {
        timer = setTimeout(() => resolve({ runId: `timeout-${Date.now().toString(36)}`, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ok: false, errorCode: 'TIMEOUT', errorMessage: `tool exceeded ${entry.tool.timeoutMs}ms`, steps: [] }), entry.tool.timeoutMs + 5_000);
      });
      try {
        result = await Promise.race([executeTool(runtime, entry.tool, inputs, { scope, pageLoadTimeoutMs: manifest.data.budget.pageLoadTimeoutMs, settleTimeoutMs: manifest.data.budget.settleTimeoutMs, now: this.now, credentials }), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      release();
    }
    const status = await this.registry.recordCall(name, result, this.options.degradeAfter ?? 2);
    this.logger.info(`call ${name}: ${result.ok ? 'ok' : `${result.errorCode} ${result.errorMessage ?? ''}`} (${result.durationMs}ms)${status === 'degraded' ? ' -> degraded' : ''}`);
    return { ...result, tool: name, ...(status ? { status } : {}) };
  }

  /** Re-run validation for published or degraded tools and update their status. */
  async revalidate(names?: string[]): Promise<Array<{ name: string; verdict: 'validated' | 'failed' | 'skipped'; status: PublishedTool['status']; reason?: string }>> {
    const entries = (await this.registry.list()).filter((e) => e.status !== 'disabled' && (!names?.length || names.includes(e.tool.name)));
    const out: Array<{ name: string; verdict: 'validated' | 'failed' | 'skipped'; status: PublishedTool['status']; reason?: string }> = [];
    const credentials = await this.credentials();
    for (const entry of entries) {
      const needsBrowser = toolNeedsBrowser(entry.tool);
      const { manifest, scope } = needsBrowser ? await this.ensureRuntime(entry.pinned.jobId) : await this.ensureManifest(entry.pinned.jobId);
      const runtime = needsBrowser ? this.runtime! : null;
      const v = await validateTool(runtime, entry.tool, { scope, pageLoadTimeoutMs: manifest.data.budget.pageLoadTimeoutMs, settleTimeoutMs: manifest.data.budget.settleTimeoutMs, runs: manifest.data.budget.validationRuns, logger: this.logger, now: this.now, credentials });
      const updated = await this.registry.setStatus(entry.tool.name, v.verdict === 'validated' ? 'published' : 'degraded', v.verdict === 'validated' ? 'revalidated' : `revalidation failed: ${v.failureReasons[0] ?? 'unknown'}`);
      out.push({ name: entry.tool.name, verdict: v.verdict, status: updated.status, ...(v.failureReasons[0] ? { reason: v.failureReasons[0] } : {}) });
      this.logger.info(`revalidate ${entry.tool.name}: ${v.verdict}${v.failureReasons[0] ? ` (${v.failureReasons[0]})` : ''}`);
    }
    return out;
  }
}
