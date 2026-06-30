import {
  AuthError,
  NotFoundError,
  ValidationError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const DOCS_API_BASE = "https://docs.googleapis.com/v1";
const DOCS_TOKEN_FILE_SUFFIX = ".docs.json";
const DOCS_REQUIRED_SCOPE = "https://www.googleapis.com/auth/documents";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/docs-smart/dist/bin/docs-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/docs-smart/dist/bin/docs-smart-auth.js ${account}`;
}

export type DocsClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the docs token-jar slot
   * (`<account>.docs.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/**
 * REST client for Google Docs API v1. Constructor builds (but does not
 * read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * The token carries both the `documents` scope (Docs read/write) and the
 * `drive.file` scope (so `create` can place the new doc and later edits can
 * re-open it); `requiredScope` records the primary `documents` scope.
 */
export class DocsClient {
  static readonly TOKEN_FILE_SUFFIX = DOCS_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = DOCS_REQUIRED_SCOPE;
  static readonly API_BASE = DOCS_API_BASE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: DocsClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: DOCS_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: DOCS_REQUIRED_SCOPE,
      });
  }

  /**
   * Account identifier this client is bound to. Mirrors the basename of
   * the token file under `~/.santo-agent/oauth/`. Read-only — used by
   * tools that surface the account in error messages.
   */
  getAccount(): string {
    return this.account;
  }

  /**
   * GET /documents/{id} — the full Document resource. `includeTabsContent`
   * surfaces multi-tab docs under `document.tabs[]` (default false flattens the
   * first tab into `document.body`). `suggestionsViewMode` controls how
   * suggested edits appear. Returns the raw resource so callers map/walk it.
   * A 404 is rewritten into a NotFoundError naming the document id.
   */
  async getDocument(opts: {
    documentId: string;
    includeTabsContent?: boolean;
    suggestionsViewMode?: string;
  }): Promise<Record<string, unknown>> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.includeTabsContent !== undefined) {
      searchParams.includeTabsContent = opts.includeTabsContent;
    }
    if (opts.suggestionsViewMode !== undefined) {
      searchParams.suggestionsViewMode = opts.suggestionsViewMode;
    }
    try {
      return await fetchJson<Record<string, unknown>>(
        `${DOCS_API_BASE}/documents/${encodeURIComponent(opts.documentId)}`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Document \`${opts.documentId}\` not found.`, {
          cause: err,
        });
      }
      throw mapDocsAuthError(err, this.account);
    }
  }

  /**
   * POST /documents — create a blank document. **Title-only**: Google ignores
   * every other field in the request (any body/content/styles are dropped), so
   * this method sends `{ title }` and callers fill content via `batchUpdate`.
   * Returns the new resource (with `documentId`, empty body).
   */
  async createDocument(opts: { title: string }): Promise<Record<string, unknown>> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<Record<string, unknown>>(
        `${DOCS_API_BASE}/documents`,
        { method: "POST", token, body: { title: opts.title } },
      );
    } catch (err) {
      throw mapDocsAuthError(err, this.account);
    }
  }

  /**
   * POST /documents/{id}:batchUpdate — apply an ordered array of Request union
   * members. Requests apply sequentially and every insert/delete renumbers
   * higher indexes, so the caller is responsible for index strategy (insert
   * first then style, or write backwards). Returns the
   * BatchUpdateDocumentResponse (`{ documentId, replies, writeControl }`);
   * `replies` is positional and 1:1 with `requests`.
   */
  async batchUpdate(opts: {
    documentId: string;
    requests: unknown[];
    writeControl?: Record<string, unknown>;
  }): Promise<{ documentId?: string; replies?: unknown[]; writeControl?: unknown }> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = { requests: opts.requests };
    if (opts.writeControl !== undefined) body.writeControl = opts.writeControl;
    try {
      return await fetchJson<{
        documentId?: string;
        replies?: unknown[];
        writeControl?: unknown;
      }>(
        `${DOCS_API_BASE}/documents/${encodeURIComponent(opts.documentId)}:batchUpdate`,
        { method: "POST", token, body },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Document \`${opts.documentId}\` not found.`, {
          cause: err,
        });
      }
      throw mapDocsAuthError(err, this.account);
    }
  }
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the `docs-smart-auth` CLI, and enrich 400 with Google's
 * own error reason. Mirrors calendar-smart's `mapCalendarAuthError`.
 */
function mapDocsAuthError(err: unknown, account: string): unknown {
  if (err instanceof NotFoundError) return err;
  if (err instanceof ValidationError) {
    const detail = (err as { detail?: unknown }).detail;
    const reason = extractGoogleErrorReason(detail);
    if (reason) {
      return new ValidationError(`${err.message} — ${reason}`, {
        detail,
        cause: err,
      });
    }
    return err;
  }
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  // The core http layer puts only `METHOD url → 403` in the message; Google's
  // reason (`SERVICE_DISABLED`, `accessNotConfigured`, ...) lives in `.detail`.
  // Search both so the "enable the API" hint fires on a real disabled-API 403.
  const detail = (err as { detail?: unknown }).detail;
  const haystack = `${msg} ${safeStringify(detail)}`;
  if (msg.includes("→ 403")) {
    if (
      haystack.includes("accessNotConfigured") ||
      haystack.includes("SERVICE_DISABLED") ||
      haystack.includes("has not been used in project")
    ) {
      return new AuthError(
        `Google Docs API is not enabled on your Cloud project. ` +
          `Enable it at https://console.developers.google.com/apis/library/docs.googleapis.com ` +
          `then wait ~30s for propagation.`,
        { cause: err },
      );
    }
    return new AuthError(
      `docs token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the documents + drive.file scopes`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `docs token rejected for account ${account}; re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}

/** JSON-stringify a value defensively for substring matching (never throws). */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Extract Google's human-readable error reason from the parsed body the core
 * http layer attached as `.detail`. Google's shape is
 * `{ error: { errors: [{ message, reason }], message, code } }`.
 */
function extractGoogleErrorReason(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { error?: unknown };
  const errBlock = d.error;
  if (typeof errBlock !== "object" || errBlock === null) return null;
  const eb = errBlock as { message?: unknown; errors?: unknown };
  if (Array.isArray(eb.errors) && eb.errors.length > 0) {
    const first = eb.errors[0] as { message?: unknown };
    if (typeof first.message === "string" && first.message.length > 0) {
      return first.message;
    }
  }
  if (typeof eb.message === "string" && eb.message.length > 0) {
    return eb.message;
  }
  return null;
}
