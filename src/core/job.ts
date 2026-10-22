import type { z } from 'zod';
import type { ArtifactEnvelope, ArtifactType, StageId } from '../schemas/common.js';
import type { FileArtifactStore, JobRecord, JobStageRecord } from './store.js';
import { StageFailedError, errorMessage } from './errors.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, debug() {} };

export function stderrLogger(verbose = false): Logger {
  return {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
    debug: (m) => {
      if (verbose) process.stderr.write(`debug: ${m}\n`);
    },
  };
}

/** Everything a stage may touch. Stages exchange data only through persisted artifacts. */
export interface StageContext<I = unknown> {
  readonly input: I;
  readonly siteId: string;
  readonly jobId: string;
  readonly store: FileArtifactStore;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  /** Read an artifact produced earlier in this job. */
  artifact<S extends z.ZodType>(type: ArtifactType, schema: S): Promise<z.infer<S>>;
  hasArtifact(type: ArtifactType): Promise<boolean>;
}

export interface StageDefinition<I = unknown> {
  readonly id: StageId;
  readonly produces: readonly ArtifactType[];
  readonly requires: readonly StageId[];
  /** Optional stages record their failure and let the job continue. */
  readonly optional: boolean;
  run(ctx: StageContext<I>): Promise<ArtifactEnvelope[]>;
}

export interface JobRunnerOptions {
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * Sequential stage runner. Persists job state after every transition so a job
 * can be inspected or resumed. Deliberately minimal: no DSL, no scheduler.
 */
export class JobRunner<I> {
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private readonly now: () => Date;

  constructor(
    private readonly store: FileArtifactStore,
    private readonly stages: readonly StageDefinition<I>[],
    options: JobRunnerOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.signal = options.signal ?? new AbortController().signal;
    this.now = options.now ?? (() => new Date());
  }

  createJob(siteId: string, jobId: string, startUrl: string): JobRecord {
    const ts = this.now().toISOString();
    return {
      jobId,
      siteId,
      startUrl,
      status: 'running',
      createdAt: ts,
      updatedAt: ts,
      stages: this.stages.map((s) => ({
        id: s.id,
        status: 'pending',
        optional: s.optional,
        attempts: 0,
        artifacts: [],
      })),
    };
  }

  /** Run all stages. Completed stages in `job` are skipped, which makes this resumable. */
  async run(job: JobRecord, input: I): Promise<JobRecord> {
    await this.store.writeJob(job);
    const ctx = this.makeContext(job, input);

    for (const stage of this.stages) {
      const record = job.stages.find((s) => s.id === stage.id);
      if (!record) throw new Error(`Job record is missing stage ${stage.id}`);
      if (record.status === 'completed') {
        this.logger.debug(`${stage.id}: already completed, skipping`);
        continue;
      }
      if (this.signal.aborted) {
        record.status = 'skipped';
        record.error = 'aborted';
        continue;
      }

      const unmet = stage.requires.filter((req) => job.stages.find((s) => s.id === req)?.status !== 'completed');
      if (unmet.length > 0) {
        record.status = 'skipped';
        record.error = `required stages not completed: ${unmet.join(', ')}`;
        this.logger.warn(`${stage.id}: skipped (${record.error})`);
        await this.touch(job);
        continue;
      }

      const leftovers: string[] = [];
      for (const type of stage.produces) if (await this.store.hasArtifact(job.siteId, job.jobId, type)) leftovers.push(type);
      if (leftovers.length > 0) {
        record.status = 'failed';
        record.error = `artifacts already exist for an incomplete stage (${leftovers.join(', ')}); artifacts are immutable, start a new job`;
        job.status = 'failed';
        await this.touch(job);
        throw new StageFailedError(stage.id, new Error(record.error));
      }

      record.status = 'running';
      record.attempts += 1;
      record.startedAt = this.now().toISOString();
      await this.touch(job);
      this.logger.info(`${stage.id}: running`);

      try {
        const artifacts = await stage.run(ctx);
        for (const artifact of artifacts) {
          await this.store.writeArtifact(artifact);
          record.artifacts.push(artifact.artifactType);
        }
        record.status = 'completed';
        record.finishedAt = this.now().toISOString();
        this.logger.info(`${stage.id}: completed (${artifacts.map((a) => a.artifactType).join(', ') || 'no artifacts'})`);
      } catch (err) {
        record.status = 'failed';
        record.finishedAt = this.now().toISOString();
        record.error = errorMessage(err);
        this.logger.warn(`${stage.id}: failed: ${record.error}`);
        if (!stage.optional) {
          job.status = 'failed';
          await this.touch(job);
          throw new StageFailedError(stage.id, err);
        }
      }
      await this.touch(job);
    }

    job.status = job.stages.some((s) => !s.optional && s.status !== 'completed') ? 'failed' : 'completed';
    await this.touch(job);
    return job;
  }

  private async touch(job: JobRecord): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await this.store.writeJob(job);
  }

  private makeContext(job: JobRecord, input: I): StageContext<I> {
    const store = this.store;
    return {
      input,
      siteId: job.siteId,
      jobId: job.jobId,
      store,
      logger: this.logger,
      signal: this.signal,
      now: this.now,
      artifact: (type, schema) => store.readArtifact(job.siteId, job.jobId, type, schema),
      hasArtifact: (type) => store.hasArtifact(job.siteId, job.jobId, type),
    };
  }
}

export function stageSummary(job: JobRecord): string {
  return job.stages.map((s: JobStageRecord) => `${s.id}=${s.status}`).join(' ');
}
