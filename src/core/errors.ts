export class WebMorphError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidTargetError extends WebMorphError {
  constructor(message: string) {
    super('INVALID_TARGET', message);
  }
}

export class SsrfBlockedError extends WebMorphError {
  constructor(message: string) {
    super('SSRF_BLOCKED', message);
  }
}

export class ScopeViolationError extends WebMorphError {
  constructor(message: string) {
    super('OUT_OF_SCOPE', message);
  }
}

export class ArtifactExistsError extends WebMorphError {
  constructor(path: string) {
    super('ARTIFACT_EXISTS', `Artifact already exists and artifacts are immutable: ${path}`);
  }
}

export class ArtifactNotFoundError extends WebMorphError {
  constructor(path: string) {
    super('ARTIFACT_NOT_FOUND', `Artifact not found: ${path}`);
  }
}

export class StageFailedError extends WebMorphError {
  constructor(stage: string, cause: unknown) {
    super('STAGE_FAILED', `Stage ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
