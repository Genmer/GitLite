// 错误模型：provider 层把 HTTP 映射进该体系，上层永不接触裸 HTTP（FR B5）
export class GitLiteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitLiteError';
    this.code = code;
  }
}

export class ValidationError extends GitLiteError {
  issues: string[];
  constructor(issues: string[]) {
    super('VALIDATION', `schema validation failed: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class UniqueConstraintError extends GitLiteError {
  field: string;
  constructor(field: string, value: string) {
    super('UNIQUE_CONSTRAINT', `duplicate value for unique field "${field}": ${value}`);
    this.name = 'UniqueConstraintError';
    this.field = field;
  }
}

export class NotFoundError extends GitLiteError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends GitLiteError {
  expected?: string;
  actual?: string;
  constructor(message: string, opts?: { expected?: string; actual?: string }) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
    this.expected = opts?.expected;
    this.actual = opts?.actual;
  }
}

export class QuotaExceededError extends GitLiteError {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('QUOTA', `remote call budget exhausted, retry after ${retryAfterMs}ms`);
    this.name = 'QuotaExceededError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimitError extends GitLiteError {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('RATE_LIMIT', `rate limited by provider, retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthError extends GitLiteError {
  constructor(message: string) {
    super('AUTH', message);
    this.name = 'AuthError';
  }
}

export class NetworkError extends GitLiteError {
  constructor(message: string) {
    super('NETWORK', message);
    this.name = 'NetworkError';
  }
}

export class FormatVersionError extends GitLiteError {
  repoVersion: string;
  clientVersion: string;
  constructor(repoVersion: string, clientVersion: string) {
    super('FORMAT_VERSION',
      `repo formatVersion ${repoVersion} is newer than client supports (${clientVersion}); upgrade GitLite`);
    this.name = 'FormatVersionError';
    this.repoVersion = repoVersion;
    this.clientVersion = clientVersion;
  }
}

export class ForeignRepoError extends GitLiteError {
  files: string[];
  constructor(files: string[]) {
    super('FOREIGN_REPO',
      `repo is not empty and not a GitLite database (contains ${files.length} foreign files); ` +
      `explicit confirmation required`);
    this.name = 'ForeignRepoError';
    this.files = files;
  }
}
