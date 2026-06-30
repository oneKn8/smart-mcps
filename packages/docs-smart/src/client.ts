import { GoogleOAuthClient } from "smart-mcp-core";

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

  // tool methods added by implementer
}
