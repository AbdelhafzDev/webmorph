import { z } from 'zod';
import { defineArtifact } from './common.js';
import { ToolErrorCode, ToolStatus } from './toolDefinition.js';

export const VALIDATION_REPORT_VERSION = '1.0.0';

export const StepResult = z.object({
  op: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  durationMs: z.number().int().nonnegative(),
  detail: z.string().optional(),
});

export const ToolRunResult = z.object({
  runId: z.string(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  ok: z.boolean(),
  errorCode: ToolErrorCode.optional(),
  errorMessage: z.string().optional(),
  steps: z.array(StepResult),
  output: z.unknown().optional(),
  finalUrl: z.string().optional(),
});
export type ToolRunResult = z.infer<typeof ToolRunResult>;

export const ValidationCheck = z.object({
  name: z.enum(['runs-succeed', 'output-schema', 'output-nonempty', 'stable-across-runs', 'latency-within-timeout']),
  passed: z.boolean(),
  detail: z.string(),
});
export type ValidationCheck = z.infer<typeof ValidationCheck>;

export const ToolValidation = z.object({
  toolId: z.string(),
  name: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  runs: z.array(ToolRunResult),
  checks: z.array(ValidationCheck),
  verdict: z.enum(['validated', 'failed', 'skipped']),
  statusAfter: ToolStatus,
  failureReasons: z.array(z.string()),
});
export type ToolValidation = z.infer<typeof ToolValidation>;

export const ValidationReportData = z.object({
  tools: z.array(ToolValidation),
  runsPerTool: z.number().int().positive(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    validated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative().default(0),
    byErrorCode: z.record(z.string(), z.number().int().nonnegative()),
  }),
});
export type ValidationReportData = z.infer<typeof ValidationReportData>;

export const ValidationReport = defineArtifact('ValidationReport', ValidationReportData);
export type ValidationReport = z.infer<typeof ValidationReport>;
