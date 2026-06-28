export type ErrorCode =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFIRM_REQUIRED"
  | "UPSTREAM"
  | "AMBIGUOUS_MATCH"
  | string;

export type SmartMcpErrorOptions = {
  recovery?: string;
  detail?: unknown;
  cause?: unknown;
};

export class SmartMcpError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: string;
  readonly detail?: unknown;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts: SmartMcpErrorOptions = {}) {
    super(message);
    this.name = "SmartMcpError";
    this.code = code;
    this.recovery = opts.recovery;
    this.detail = opts.detail;
    this.cause = opts.cause;
  }
}

export class AuthError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("AUTH", message, opts);
    this.name = "AuthError";
  }
}

/**
 * The token is valid and adequately scoped, but the caller lacks permission on
 * the specific resource (e.g. trying to trash a Drive file owned by someone
 * else). Distinct from AuthError so clients don't mislabel it as a scope/
 * re-consent problem — re-authing never fixes an ownership 403.
 */
export class PermissionError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("PERMISSION", message, opts);
    this.name = "PermissionError";
  }
}

export class RateLimitError extends SmartMcpError {
  readonly retryAfterSec?: number;
  constructor(message: string, opts: SmartMcpErrorOptions & { retryAfterSec?: number } = {}) {
    super("RATE_LIMIT", message, opts);
    this.name = "RateLimitError";
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export class NotFoundError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("NOT_FOUND", message, opts);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("VALIDATION", message, opts);
    this.name = "ValidationError";
  }
}

export class ConfirmRequiredError extends SmartMcpError {
  readonly preview: string;
  constructor(message: string, opts: SmartMcpErrorOptions & { preview: string }) {
    super("CONFIRM_REQUIRED", message, opts);
    this.name = "ConfirmRequiredError";
    this.preview = opts.preview;
  }
}

export class UpstreamError extends SmartMcpError {
  constructor(message: string, opts: SmartMcpErrorOptions = {}) {
    super("UPSTREAM", message, opts);
    this.name = "UpstreamError";
  }
}

export type FuzzyCandidate = { score: number; label: string; id?: string };

export class AmbiguousMatchError extends SmartMcpError {
  readonly candidates: FuzzyCandidate[];
  constructor(message: string, opts: SmartMcpErrorOptions & { candidates: FuzzyCandidate[] }) {
    super("AMBIGUOUS_MATCH", message, opts);
    this.name = "AmbiguousMatchError";
    this.candidates = opts.candidates;
  }
}

export type McpToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export function toMcpResult(err: unknown): McpToolResult {
  const wrapped = err instanceof SmartMcpError
    ? err
    : new UpstreamError(err instanceof Error ? err.message : String(err), { cause: err });

  const lines: string[] = [`[${wrapped.code}] ${wrapped.message}`];
  if (wrapped.recovery) lines.push(`Hint: ${wrapped.recovery}`);
  if (wrapped instanceof ConfirmRequiredError) {
    lines.push(`Preview:\n${wrapped.preview}`);
  }
  if (wrapped instanceof AmbiguousMatchError && wrapped.candidates.length > 0) {
    lines.push(
      `Candidates:\n${wrapped.candidates
        .map(c => `  - ${c.label}${c.id ? ` (${c.id})` : ""} score=${c.score.toFixed(2)}`)
        .join("\n")}`,
    );
  }
  if (wrapped.detail !== undefined) {
    let detailText: string;
    if (typeof wrapped.detail === "string") {
      detailText = wrapped.detail;
    } else {
      try {
        detailText = JSON.stringify(wrapped.detail) ?? String(wrapped.detail);
      } catch {
        detailText = String(wrapped.detail);
      }
    }
    lines.push(`Detail: ${detailText}`);
  }

  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
