import {
  AuthError,
  NotFoundError,
  GoogleOAuthClient,
} from "smart-mcp-core";

const GDRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GDRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const GDRIVE_TOKEN_FILE_SUFFIX = ".gdrive.json";
const GDRIVE_REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/gdrive-smart/dist/bin/gdrive-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/gdrive-smart/dist/bin/gdrive-smart-auth.js ${account}`;
}

export type GDriveClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the drive token-jar slot
   * (`<account>.gdrive.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/**
 * REST client for Google Drive API v3. Constructor builds (but does not
 * read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * Split-responsibility design: all JSON operations (create/update/copy/
 * delete/list/get/permissions) live here and go through core `fetchJson`.
 * The binary/multipart media layer lives in `media.ts` and reuses the
 * public `accessToken()` getter below rather than `fetchJson`, so raw
 * bytes never pollute the JSON transport path.
 */
export class GDriveClient {
  static readonly API_BASE = GDRIVE_API_BASE;
  static readonly UPLOAD_BASE = GDRIVE_UPLOAD_BASE;
  static readonly TOKEN_FILE_SUFFIX = GDRIVE_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = GDRIVE_REQUIRED_SCOPE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: GDriveClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: GDRIVE_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: GDRIVE_REQUIRED_SCOPE,
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
   * Mint (or refresh) an OAuth access token for the bound account. Public
   * because the `media.ts` layer needs a token getter to perform its raw
   * `fetch` calls (multipart upload, blob download, doc export) without
   * routing through `fetchJson`.
   */
  async accessToken(): Promise<string> {
    return this.oauthClient.getAccessToken();
  }

  // JSON methods added by implementer A
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the `gdrive-smart-auth` CLI. `fetchJson` already
 * maps both statuses to AuthError generically; we re-throw a friendlier
 * one. Other error types pass through unchanged.
 *
 * Exported for use by JSON methods (implementer A) and the media layer
 * (implementer B) so error mapping stays uniform across both paths.
 */
export function mapGDriveAuthError(err: unknown, account: string): unknown {
  if (err instanceof NotFoundError) return err;
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    if (
      msg.includes("accessNotConfigured") ||
      msg.includes("SERVICE_DISABLED") ||
      msg.includes("has not been used in project")
    ) {
      return new AuthError(
        `Google Drive API is not enabled on your Cloud project. ` +
          `Enable it at https://console.developers.google.com/apis/library/drive.googleapis.com ` +
          `then wait ~30s for propagation.`,
        { cause: err },
      );
    }
    return new AuthError(
      `drive token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the drive scope`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `drive token rejected for account ${account}; ` +
        `re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}
