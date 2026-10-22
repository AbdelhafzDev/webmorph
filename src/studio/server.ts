import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FileArtifactStore } from '../core/store.js';
import type { Logger } from '../core/job.js';
import { silentLogger } from '../core/job.js';
import { ArtifactType } from '../schemas/common.js';
import { ToolRegistry } from '../registry/registry.js';
import { ToolExecutor } from '../adapter/executor.js';
import { discover, PHASE1_STAGES, PHASE3_STAGES, DEFAULT_STAGES, type DiscoverOptions } from '../index.js';
import { STUDIO_HTML } from './ui.js';
import { WEBMORPH_VERSION } from '../version.js';

export interface StudioOptions {
  store: FileArtifactStore;
  host?: string;
  port?: number;
  logger?: Logger;
}

interface RunRecord {
  runId: string;
  startUrl: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  siteId?: string;
  jobId?: string;
  error?: string;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const MIME: Record<string, string> = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.yaml': 'text/yaml', '.json': 'application/json', '.md': 'text/markdown', '.jsonl': 'application/x-ndjson' };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * WebMorph Studio: a local review surface over the artifact store. Read
 * evidence, approve and publish tools, try them, and start discovery runs.
 * Binds to loopback only and has no authentication by design: it is a local tool.
 */
export class StudioServer {
  private server?: http.Server;
  private readonly executors = new Map<string, ToolExecutor>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly logger: Logger;

  constructor(private readonly options: StudioOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('studio not started');
    return `http://${this.options.host ?? '127.0.0.1'}:${addr.port}`;
  }

  async start(): Promise<string> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this.url;
  }

  async close(): Promise<void> {
    for (const e of this.executors.values()) await e.close();
    this.executors.clear();
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private executor(siteId: string): ToolExecutor {
    let e = this.executors.get(siteId);
    if (!e) {
      e = new ToolExecutor({ store: this.options.store, siteId, logger: this.logger });
      this.executors.set(siteId, e);
    }
    return e;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(STUDIO_HTML);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      const parts = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      const body = method === 'POST' ? await readJson(req) : {};
      const result = await this.route(method, parts, body, res);
      if (result !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(result));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) this.logger.warn(`studio: ${message}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async route(method: string, parts: string[], body: Record<string, unknown>, res: http.ServerResponse): Promise<unknown> {
    const store = this.options.store;
    const [head, siteId, section, a, b, ...rest] = parts;
    if (head === 'version' && method === 'GET') return { version: WEBMORPH_VERSION };

    if (head === 'runs') {
      if (method === 'GET' && !siteId) return Array.from(this.runs.values()).map((r) => ({ ...r, log: r.log.slice(-5) }));
      if (method === 'GET' && siteId) return this.runs.get(siteId) ?? badRequest(404, 'run not found');
      throw new HttpError(405, 'method not allowed');
    }
    if (head === 'discover' && method === 'POST') return this.startRun(body);

    if (head !== 'sites') throw new HttpError(404, 'not found');
    if (!siteId) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      return this.listSites();
    }
    if (!ID.test(siteId)) throw new HttpError(400, 'bad site id');

    if (!section) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      return this.siteDetail(siteId);
    }
    if (section === 'registry' && method === 'GET') return new ToolRegistry(store, siteId).load();
    if (section === 'publish' && method === 'POST') {
      return new ToolRegistry(store, siteId).publish({ jobId: str(body['jobId']), names: Array.isArray(body['names']) ? (body['names'] as string[]) : undefined, force: body['force'] === true });
    }
    if (section === 'revalidate' && method === 'POST') return this.executor(siteId).revalidate(Array.isArray(body['names']) ? (body['names'] as string[]) : undefined);
    if (section === 'tools' && a && ID.test(a)) {
      if (b === 'status' && method === 'POST') {
        const status = str(body['status']);
        if (status !== 'published' && status !== 'disabled' && status !== 'degraded') throw new HttpError(400, 'status must be published, disabled or degraded');
        return new ToolRegistry(store, siteId).setStatus(a, status, str(body['reason']) ?? 'studio');
      }
      if (b === 'call' && method === 'POST') return this.executor(siteId).call(a, (body['inputs'] as Record<string, unknown>) ?? {});
    }
    if (section === 'recordings') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      if (!a) return this.listRecordings(siteId);
      if (!ID.test(a)) throw new HttpError(400, 'bad session id');
      const dir = store.recordingDir(siteId, a);
      if (b === 'blobs') return this.sendFile(res, dir, rest.join('/'));
      const session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as unknown;
      const events = await readJsonl(join(dir, 'events.jsonl'), 5000);
      const network = await readJsonl(join(dir, 'network.jsonl'), 2000);
      return { session, events, network };
    }
    if (section === 'jobs') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      if (!a) return this.jobsOf(siteId);
      if (!ID.test(a)) throw new HttpError(400, 'bad job id');
      const jobId = a;
      if (!b) {
        const job = await store.readJob(siteId, jobId);
        const artifacts: string[] = [];
        for (const type of ArtifactType.options) if (await store.hasArtifact(siteId, jobId, type)) artifacts.push(type);
        return { job, artifacts };
      }
      if (b === 'artifacts' && rest[0]) {
        const type = rest[0];
        if (!ArtifactType.options.includes(type as (typeof ArtifactType.options)[number])) throw new HttpError(400, 'unknown artifact type');
        try {
          return JSON.parse(await readFile(store.artifactPath(siteId, jobId, type as (typeof ArtifactType.options)[number]), 'utf8')) as unknown;
        } catch {
          throw new HttpError(404, 'artifact not found');
        }
      }
      if (b === 'evidence' && rest[0] && ID.test(rest[0])) return readJsonl(store.evidencePath(siteId, jobId, rest[0]), 5000);
      if (b === 'blobs') return this.sendFile(res, store.jobDir(siteId, jobId), ['blobs', ...rest].join('/'));
    }
    throw new HttpError(404, 'not found');
  }

  private async listSites(): Promise<unknown[]> {
    const { readdir } = await import('node:fs/promises');
    let ids: string[] = [];
    try {
      ids = await readdir(join(this.options.store.rootDir, 'sites'));
    } catch {
      ids = [];
    }
    const out: unknown[] = [];
    for (const siteId of ids) {
      try {
        const site = JSON.parse(await readFile(join(this.options.store.siteDir(siteId), 'site.json'), 'utf8')) as Record<string, unknown>;
        const registry = await new ToolRegistry(this.options.store, siteId).load();
        const tools = Object.values(registry.tools);
        out.push({ ...site, published: tools.filter((t) => t.status === 'published').length, degraded: tools.filter((t) => t.status === 'degraded').length, recordings: (await this.options.store.listRecordings(siteId)).length });
      } catch {
        // skip unreadable site folders
      }
    }
    return out;
  }

  private async siteDetail(siteId: string): Promise<unknown> {
    const site = JSON.parse(await readFile(join(this.options.store.siteDir(siteId), 'site.json'), 'utf8').catch(() => badRequest(404, 'site not found'))) as unknown;
    return { site, jobs: await this.jobsOf(siteId), registry: await new ToolRegistry(this.options.store, siteId).load(), recordings: await this.listRecordings(siteId) };
  }

  private async jobsOf(siteId: string): Promise<unknown[]> {
    const jobs: unknown[] = [];
    for (const jobId of await this.options.store.listJobs(siteId)) {
      try {
        jobs.push(await this.options.store.readJob(siteId, jobId));
      } catch {
        // skip
      }
    }
    return jobs.reverse();
  }

  private async listRecordings(siteId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const id of await this.options.store.listRecordings(siteId)) {
      try {
        out.push(JSON.parse(await readFile(join(this.options.store.recordingDir(siteId, id), 'session.json'), 'utf8')));
      } catch {
        // skip
      }
    }
    return out.reverse();
  }

  private async sendFile(res: http.ServerResponse, baseDir: string, rel: string): Promise<undefined> {
    const target = normalize(join(baseDir, rel));
    if (!target.startsWith(normalize(baseDir) + '/') || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
    try {
      const s = await stat(target);
      if (!s.isFile()) throw new HttpError(404, 'not found');
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(404, 'not found');
    }
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' }).end(data);
    return undefined;
  }

  private startRun(body: Record<string, unknown>): { runId: string } {
    const startUrl = str(body['url']);
    if (!startUrl) throw new HttpError(400, 'url is required');
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const record: RunRecord = { runId, startUrl, status: 'running', startedAt: new Date().toISOString(), log: [] };
    this.runs.set(runId, record);
    const push = (line: string) => {
      if (record.log.length < 2000) record.log.push(line);
    };
    const opts = (body['options'] as Record<string, unknown> | undefined) ?? {};
    const stages = opts['stages'] === 'phase1' ? PHASE1_STAGES : opts['stages'] === 'phase3' ? PHASE3_STAGES : DEFAULT_STAGES;
    const budget: Record<string, number> = {};
    for (const key of ['maxPages', 'maxDepth', 'maxPagesToInspect', 'maxProbesTotal', 'validationRuns', 'minDelayMs']) if (typeof opts[key] === 'number') budget[key] = opts[key] as number;
    const options: DiscoverOptions = {
      startUrl,
      outDir: this.options.store.rootDir,
      stages,
      allowPrivate: opts['allowPrivate'] === true,
      model: { enabled: opts['model'] !== false },
      budget,
      logger: { info: push, warn: (m) => push(`warning: ${m}`), debug: () => {} },
    };
    void discover(options)
      .then((result) => {
        record.status = result.job.status === 'completed' ? 'completed' : 'failed';
        record.siteId = result.siteId;
        record.jobId = result.jobId;
        record.finishedAt = new Date().toISOString();
      })
      .catch((err: unknown) => {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
        record.finishedAt = new Date().toISOString();
      });
    return { runId };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function badRequest(status: number, message: string): never {
  throw new HttpError(status, message);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

async function readJsonl(path: string, limit: number): Promise<unknown[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(0, limit)
      .map((l) => JSON.parse(l) as unknown);
  } catch {
    return [];
  }
}
