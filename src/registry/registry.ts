import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { FileArtifactStore } from '../core/store.js';
import { WebMorphError } from '../core/errors.js';
import { SiteManifest } from '../schemas/siteManifest.js';
import { ToolDefinition, type ToolSpec } from '../schemas/toolDefinition.js';
import { ValidationReport } from '../schemas/validationReport.js';
import { RegistryFile, REGISTRY_VERSION, type PublishedStatus, type PublishedTool } from '../schemas/registry.js';
import type { ToolRunResult } from '../schemas/validationReport.js';

export interface PublishOptions {
  jobId?: string;
  names?: string[];
  all?: boolean;
  /** Publish tools that did not pass validation. Off by default. */
  force?: boolean;
  now?: () => Date;
}

export interface PublishResult {
  jobId: string;
  published: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** Failure codes that indicate the site changed rather than the caller erring. */
const SITE_FAILURE_CODES = new Set(['SITE_CHANGED', 'LOCATOR_MISSING', 'OUTPUT_INVALID']);

/**
 * The published-tool registry: what agents are allowed to call. Each entry is
 * a snapshot of a validated tool pinned to the job and artifacts it was
 * validated against, with a status lifecycle and call statistics.
 */
export class ToolRegistry {
  constructor(
    private readonly store: FileArtifactStore,
    readonly siteId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get path(): string {
    return join(this.store.siteDir(this.siteId), 'registry.json');
  }

  async load(): Promise<RegistryFile> {
    try {
      return RegistryFile.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const site = await this.readSite();
      return { schemaVersion: REGISTRY_VERSION, siteId: this.siteId, origin: site.origin, updatedAt: this.now().toISOString(), tools: {} };
    }
  }

  async save(registry: RegistryFile): Promise<void> {
    registry.updatedAt = this.now().toISOString();
    RegistryFile.parse(registry);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(registry, null, 2));
    await rename(tmp, this.path);
  }

  async list(): Promise<PublishedTool[]> {
    return Object.values((await this.load()).tools);
  }

  async listPublished(): Promise<PublishedTool[]> {
    return (await this.list()).filter((t) => t.status === 'published');
  }

  async get(name: string): Promise<PublishedTool | undefined> {
    return (await this.load()).tools[name];
  }

  async publish(options: PublishOptions = {}): Promise<PublishResult> {
    const jobId = options.jobId ?? (await this.readSite()).latestJobId;
    const manifest = await this.store.readArtifact(this.siteId, jobId, 'SiteManifest', SiteManifest);
    const definition = await this.store.readArtifact(this.siteId, jobId, 'ToolDefinition', ToolDefinition);
    const report = (await this.store.hasArtifact(this.siteId, jobId, 'ValidationReport')) ? await this.store.readArtifact(this.siteId, jobId, 'ValidationReport', ValidationReport) : undefined;
    const registry = await this.load();
    const wanted = options.all || !options.names?.length ? definition.data.tools.map((t) => t.name) : options.names;
    const published: string[] = [];
    const skipped: PublishResult['skipped'] = [];
    const ts = this.now().toISOString();

    for (const name of wanted) {
      const tool = definition.data.tools.find((t) => t.name === name);
      if (!tool) {
        skipped.push({ name, reason: `not in job ${jobId}` });
        continue;
      }
      const verdict = report?.data.tools.find((t) => t.toolId === tool.toolId);
      if (!options.force) {
        if (!verdict) {
          skipped.push({ name, reason: 'no validation result; use --force to publish anyway' });
          continue;
        }
        if (verdict.verdict !== 'validated') {
          skipped.push({ name, reason: `validation failed: ${verdict.failureReasons[0] ?? 'unknown'}` });
          continue;
        }
      }
      if (tool.sideEffectClass !== 'read') {
        skipped.push({ name, reason: `side effect class ${tool.sideEffectClass} is not publishable in v1` });
        continue;
      }
      const existing = registry.tools[name];
      const snapshot: ToolSpec = { ...tool, status: 'published' };
      registry.tools[name] = {
        tool: snapshot,
        status: 'published',
        pinned: {
          jobId,
          manifestArtifactId: manifest.artifactId,
          toolDefinitionArtifactId: definition.artifactId,
          ...(report ? { validationReportArtifactId: report.artifactId, validatedAt: report.createdAt } : {}),
        },
        publishedAt: existing?.publishedAt ?? ts,
        history: [...(existing?.history ?? []), { at: ts, from: existing?.status ?? (verdict ? 'validated' : 'draft'), to: 'published', reason: existing ? `republished from job ${jobId}` : `published from job ${jobId}${options.force ? ' (forced)' : ''}` }],
        calls: existing?.calls ?? { total: 0, ok: 0, failed: 0, consecutiveFailures: 0 },
      };
      published.push(name);
    }
    await this.save(registry);
    return { jobId, published, skipped };
  }

  async setStatus(name: string, status: PublishedStatus, reason: string): Promise<PublishedTool> {
    const registry = await this.load();
    const entry = registry.tools[name];
    if (!entry) throw new WebMorphError('TOOL_UNAVAILABLE', `Tool ${name} is not in the registry for ${this.siteId}`);
    if (entry.status !== status) {
      entry.history.push({ at: this.now().toISOString(), from: entry.status, to: status, reason });
      entry.status = status;
      entry.tool.status = status;
      if (status === 'published') entry.calls.consecutiveFailures = 0;
    }
    await this.save(registry);
    return entry;
  }

  /** Record a call; consecutive site-change failures degrade the tool. Returns the status afterwards. */
  async recordCall(name: string, result: Pick<ToolRunResult, 'ok' | 'errorCode' | 'errorMessage'>, degradeAfter = 2): Promise<PublishedStatus | undefined> {
    const registry = await this.load();
    const entry = registry.tools[name];
    if (!entry) return undefined;
    const ts = this.now().toISOString();
    entry.calls.total += 1;
    entry.calls.lastCalledAt = ts;
    if (result.ok) {
      entry.calls.ok += 1;
      entry.calls.lastOkAt = ts;
      entry.calls.consecutiveFailures = 0;
    } else {
      entry.calls.failed += 1;
      entry.calls.lastError = `${result.errorCode ?? 'ERROR'}: ${result.errorMessage ?? ''}`.slice(0, 300);
      if (result.errorCode && (SITE_FAILURE_CODES.has(result.errorCode) || (result.errorCode === 'NOT_FOUND' && !toolTakesPathInputs(entry.tool)))) {
        entry.calls.consecutiveFailures += 1;
        if (entry.status === 'published' && entry.calls.consecutiveFailures >= degradeAfter) {
          entry.history.push({ at: ts, from: entry.status, to: 'degraded', reason: `${entry.calls.consecutiveFailures} consecutive failures: ${entry.calls.lastError}` });
          entry.status = 'degraded';
          entry.tool.status = 'degraded';
        }
      }
    }
    await this.save(registry);
    return entry.status;
  }

  private async readSite(): Promise<{ origin: string; latestJobId: string }> {
    const path = join(this.store.siteDir(this.siteId), 'site.json');
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { origin: string; latestJobId: string };
    } catch {
      throw new WebMorphError('SITE_UNKNOWN', `No site record at ${path}; run discover first`);
    }
  }
}

function toolTakesPathInputs(tool: ToolSpec): boolean {
  return tool.program.some((s) => s.op === 'navigate' && /\{\{/.test(s.url));
}
