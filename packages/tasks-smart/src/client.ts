import { GoogleOAuthClient } from "smart-mcp-core";

const TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1";
const TASKS_TOKEN_FILE_SUFFIX = ".tasks.json";
const TASKS_REQUIRED_SCOPE = "https://www.googleapis.com/auth/tasks";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/tasks-smart/dist/bin/tasks-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/tasks-smart/dist/bin/tasks-smart-auth.js ${account}`;
}

export type TasksClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the tasks token-jar slot
   * (`<account>.tasks.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/**
 * REST client for Google Tasks API v1. Constructor builds (but does not
 * read) the OAuth client; the token file is opened lazily on the first
 * method call.
 */
export class TasksClient {
  static readonly TOKEN_FILE_SUFFIX = TASKS_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = TASKS_REQUIRED_SCOPE;
  static readonly API_BASE = TASKS_API_BASE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: TasksClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: TASKS_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: TASKS_REQUIRED_SCOPE,
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
