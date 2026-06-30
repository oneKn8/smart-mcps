import { GoogleOAuthClient } from "smart-mcp-core";

const APPS_SCRIPT_API_BASE = "https://script.googleapis.com/v1";
const APPS_SCRIPT_TOKEN_FILE_SUFFIX = ".script.json";
const APPS_SCRIPT_REQUIRED_SCOPE =
  "https://www.googleapis.com/auth/script.projects";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js ${account}`;
}

export type AppsScriptClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the apps-script token-jar slot
   * (`<account>.script.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/**
 * REST client for Google Apps Script API v1. Constructor builds (but does
 * not read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * The token carries the `script.projects`, `script.deployments`,
 * `script.processes`, and `script.metrics` scopes (plus the runtime scopes
 * a deployed script declares when `scripts.run` is used); `requiredScope`
 * records the primary `script.projects` scope.
 */
export class AppsScriptClient {
  static readonly TOKEN_FILE_SUFFIX = APPS_SCRIPT_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = APPS_SCRIPT_REQUIRED_SCOPE;
  static readonly API_BASE = APPS_SCRIPT_API_BASE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: AppsScriptClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: APPS_SCRIPT_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: APPS_SCRIPT_REQUIRED_SCOPE,
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
