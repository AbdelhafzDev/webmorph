import { mkdir, readFile, writeFile, appendFile, access, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ArtifactEnvelope, ArtifactType, StageId } from '../schemas/common.js';
import { SiteConfig, emptySiteConfig, type ApiCredential } from '../schemas/siteConfig.js';
import { ArtifactExistsError, ArtifactNotFoundError } from './errors.js';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface JobStageRecord {
  id: StageId;
  status: StageStatus;
  optional: boolean;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  artifacts: ArtifactType[];
}

export interface JobRecord {
  jobId: string;
  siteId: string;
  startUrl: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  stages: JobStageRecord[];
}

export interface SiteRecord {
  siteId: string;
  origin: string;
  latestJobId: string;
  jobIds: string[];
  updatedAt: string;
}

/**
 * Filesystem artifact store.
 *
 * Layout:
 *   <root>/sites/<siteId>/site.json
 *   <root>/sites/<siteId>/config.json                        (mutable operator config; the only home of credential values)
 *   <root>/sites/<siteId>/jobs/<jobId>/job.json             (mutable job state)
 *   <root>/sites/<siteId>/jobs/<jobId>/artifacts/<Type>.json (immutable)
 *   <root>/sites/<siteId>/jobs/<jobId>/evidence/<name>.jsonl (append-only)
 *   <root>/sites/<siteId>/jobs/<jobId>/blobs/...             (binary evidence)
 */
export class FileArtifactStore {
  constructor(readonly rootDir: string) {}

  siteDir(siteId: string): string {
    return join(this.rootDir, 'sites', siteId);
  }

  jobDir(siteId: string, jobId: string): string {
    return join(this.siteDir(siteId), 'jobs', jobId);
  }

  artifactPath(siteId: string, jobId: string, type: ArtifactType): string {
    return join(this.jobDir(siteId, jobId), 'artifacts', `${type}.json`);
  }

  evidencePath(siteId: string, jobId: string, name: string): string {
    return join(this.jobDir(siteId, jobId), 'evidence', `${name}.jsonl`);
  }

  blobPath(siteId: string, jobId: string, relPath: string): string {
    return join(this.jobDir(siteId, jobId), 'blobs', relPath);
  }

  /** Write an artifact. Fails if one of the same type already exists for the job. */
  async writeArtifact<A extends ArtifactEnvelope>(artifact: A): Promise<string> {
    const path = this.artifactPath(artifact.siteId, artifact.jobId, artifact.artifactType);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, JSON.stringify(artifact, null, 2), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ArtifactExistsError(path);
      throw err;
    }
    return path;
  }

  async hasArtifact(siteId: string, jobId: string, type: ArtifactType): Promise<boolean> {
    try {
      await access(this.artifactPath(siteId, jobId, type), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readArtifact<S extends z.ZodType>(siteId: string, jobId: string, type: ArtifactType, schema: S): Promise<z.infer<S>> {
    const path = this.artifactPath(siteId, jobId, type);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactNotFoundError(path);
      throw err;
    }
    return schema.parse(JSON.parse(raw));
  }

  /** Content-addressed blob storage. Writing the same bytes twice is a no-op. */
  async writeBlob(siteId: string, jobId: string, subdir: string, contentType: string, data: Buffer, ext: string): Promise<{ path: string; contentType: string; bytes: number; sha1: string }> {
    const sha1 = createHash('sha1').update(data).digest('hex');
    const rel = join('blobs', subdir, `${sha1.slice(0, 16)}${ext}`);
    const abs = join(this.jobDir(siteId, jobId), rel);
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(abs, data, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { path: rel, contentType, bytes: data.byteLength, sha1 };
  }

  async appendEvidence(siteId: string, jobId: string, name: string, record: unknown): Promise<void> {
    const path = this.evidencePath(siteId, jobId, name);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n');
  }

  async writeJob(job: JobRecord): Promise<void> {
    const path = join(this.jobDir(job.siteId, job.jobId), 'job.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(job, null, 2));
  }

  async readJob(siteId: string, jobId: string): Promise<JobRecord> {
    const path = join(this.jobDir(siteId, jobId), 'job.json');
    return JSON.parse(await readFile(path, 'utf8')) as JobRecord;
  }

  async upsertSite(siteId: string, origin: string, jobId: string): Promise<void> {
    const path = join(this.siteDir(siteId), 'site.json');
    await mkdir(dirname(path), { recursive: true });
    let record: SiteRecord | undefined;
    try {
      record = JSON.parse(await readFile(path, 'utf8')) as SiteRecord;
    } catch {
      record = undefined;
    }
    const jobIds = Array.from(new Set([...(record?.jobIds ?? []), jobId]));
    const next: SiteRecord = { siteId, origin, latestJobId: jobId, jobIds, updatedAt: new Date().toISOString() };
    await writeFile(path, JSON.stringify(next, null, 2));
  }

  siteConfigPath(siteId: string): string {
    return join(this.siteDir(siteId), 'config.json');
  }

  /** The mutable site config; an empty one when none has been written. */
  async readSiteConfig(siteId: string): Promise<SiteConfig> {
    let raw: string;
    try {
      raw = await readFile(this.siteConfigPath(siteId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptySiteConfig(siteId);
      throw err;
    }
    return SiteConfig.parse(JSON.parse(raw));
  }

  /** Atomic, owner-only write: the file holds credential values. */
  async writeSiteConfig(config: SiteConfig): Promise<void> {
    const path = this.siteConfigPath(config.siteId);
    SiteConfig.parse(config);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  }

  /** Add or replace credentials by name. Returns the config as written. */
  async upsertApiCredentials(siteId: string, credentials: readonly ApiCredential[], now: () => Date = () => new Date()): Promise<SiteConfig> {
    const config = await this.readSiteConfig(siteId);
    for (const credential of credentials) {
      const i = config.apiCredentials.findIndex((c) => c.name === credential.name);
      if (i >= 0) config.apiCredentials[i] = credential;
      else config.apiCredentials.push(credential);
    }
    config.updatedAt = now().toISOString();
    await this.writeSiteConfig(config);
    return config;
  }

  /** Remove a credential by name. Returns whether one was removed. */
  async removeApiCredential(siteId: string, name: string, now: () => Date = () => new Date()): Promise<boolean> {
    const config = await this.readSiteConfig(siteId);
    const before = config.apiCredentials.length;
    config.apiCredentials = config.apiCredentials.filter((c) => c.name !== name);
    if (config.apiCredentials.length === before) return false;
    config.updatedAt = now().toISOString();
    await this.writeSiteConfig(config);
    return true;
  }

  recordingDir(siteId: string, sessionId: string): string {
    return join(this.siteDir(siteId), 'recordings', sessionId);
  }

  async listRecordings(siteId: string): Promise<string[]> {
    try {
      return (await readdir(join(this.siteDir(siteId), 'recordings'))).sort();
    } catch {
      return [];
    }
  }

  async listJobs(siteId: string): Promise<string[]> {
    try {
      return (await readdir(join(this.siteDir(siteId), 'jobs'))).sort();
    } catch {
      return [];
    }
  }
}
