import {
  AuthError,
  NotFoundError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const GDRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GDRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const GDRIVE_TOKEN_FILE_SUFFIX = ".gdrive.json";
const GDRIVE_REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Explicit `fields` mask for every File-returning method. Drive returns only
 * a subset of File fields by default; without this mask `parents`, `owners`,
 * `webViewLink`, `size`, etc. never come back. Requested once here so the
 * slim mapper always has what it needs.
 */
const FILE_FIELDS =
  "id,name,mimeType,parents,owners(displayName,emailAddress)," +
  "webViewLink,trashed,starred,size,modifiedTime,capabilities(canEdit)";

/** `fields` mask for files.list — the File mask nested under `files(...)`. */
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

/** `fields` mask for permission-returning methods. `allowFileDiscovery`
 * distinguishes a discoverable/searchable link from an anyone-with-the-link
 * grant (L3). */
const PERMISSION_FIELDS = "id,type,role,emailAddress,domain,allowFileDiscovery";

/** files.list pageSize is capped at 100 by Drive; clamp to keep behavior sane. */
const MAX_PAGE_SIZE = 100;

function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return MAX_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_SIZE);
}

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

  // ===========================================================================
  // Create / organize
  // ===========================================================================

  /**
   * POST /files with `mimeType: application/vnd.google-apps.folder` — create a
   * folder. `parentId`, when set, places the folder inside that parent (a file
   * has at most one parent); omitting it lands the folder in My Drive root.
   * Returns the raw File resource shaped by the `FILE_FIELDS` mask.
   */
  async createFolder(opts: {
    name: string;
    parentId?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {
      name: opts.name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (opts.parentId !== undefined) body.parents = [opts.parentId];
    try {
      return await fetchJson<unknown>(`${GDRIVE_API_BASE}/files`, {
        method: "POST",
        token,
        body,
        searchParams: { fields: FILE_FIELDS, supportsAllDrives: true },
      });
    } catch (err) {
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * POST /files with `mimeType: application/vnd.google-apps.shortcut` and a
   * `shortcutDetails.targetId` — create a shortcut that points at an existing
   * file or folder. Shortcuts are how one item appears in multiple folders
   * (multi-parenting is gone). Optional `parentId` places the shortcut.
   */
  async createShortcut(opts: {
    name: string;
    targetId: string;
    parentId?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {
      name: opts.name,
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: opts.targetId },
    };
    if (opts.parentId !== undefined) body.parents = [opts.parentId];
    try {
      return await fetchJson<unknown>(`${GDRIVE_API_BASE}/files`, {
        method: "POST",
        token,
        body,
        searchParams: { fields: FILE_FIELDS, supportsAllDrives: true },
      });
    } catch (err) {
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * GET /files/generateIds — pre-allocate real Drive file ids for idempotent
   * creates/uploads (pass a generated id as `id` in a create body so a retried
   * upload reuses it instead of duplicating). `count` defaults to 10 (Drive's
   * own default, max 1000). Returns a normalized `{ ids }` shape.
   */
  async generateIds(opts: { count?: number } = {}): Promise<{ ids: string[] }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { space: "drive", type: "files" };
    if (opts.count !== undefined) searchParams.count = opts.count;
    let raw: { ids?: unknown };
    try {
      raw = await fetchJson<{ ids?: unknown }>(
        `${GDRIVE_API_BASE}/files/generateIds`,
        { token, searchParams },
      );
    } catch (err) {
      throw mapGDriveAuthError(err, this.account);
    }
    return {
      ids: Array.isArray(raw.ids)
        ? raw.ids.filter((x): x is string => typeof x === "string")
        : [],
    };
  }

  /**
   * PATCH /files/{fileId} — the one method behind rename / star / trash /
   * restore / move / update_metadata. `body` carries the editable File fields
   * (`name`, `starred`, `trashed`, `description`); it may be empty for a pure
   * move. `addParents` / `removeParents` are QUERY params (comma-separated
   * parent-id lists), NOT body fields — that is how a move is expressed. Always
   * requests `FILE_FIELDS` so the returned resource carries parents/links.
   *
   * A 404 is rewritten into a NotFoundError naming the file id.
   */
  async updateFile(
    fileId: string,
    body: {
      name?: string;
      starred?: boolean;
      trashed?: boolean;
      description?: string;
    },
    parents: { addParents?: string; removeParents?: string } = {},
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { fields: FILE_FIELDS, supportsAllDrives: true };
    if (parents.addParents !== undefined) {
      searchParams.addParents = parents.addParents;
    }
    if (parents.removeParents !== undefined) {
      searchParams.removeParents = parents.removeParents;
    }
    try {
      return await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
        { method: "PATCH", token, body, searchParams },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * POST /files/{fileId}/copy — copy a single file (Drive does NOT copy
   * folders; the tool layer rejects folders up front). `name` / `parentId`
   * on the body let the copy land under a new name/folder. Returns the raw
   * File resource of the copy, shaped by `FILE_FIELDS`.
   */
  async copyFile(
    fileId: string,
    opts: { name?: string; parentId?: string } = {},
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.parentId !== undefined) body.parents = [opts.parentId];
    try {
      return await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy`,
        {
          method: "POST",
          token,
          body,
          searchParams: { fields: FILE_FIELDS, supportsAllDrives: true },
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  // ===========================================================================
  // Lifecycle (trash is `updateFile`; these two are the PERMANENT ops)
  // ===========================================================================

  /**
   * DELETE /files/{fileId} — PERMANENTLY delete a file, bypassing Trash (if a
   * folder, all descendants the user owns go too). Irreversible; the tool layer
   * hard-gates this behind an explicit confirm. Returns 204 (no value).
   */
  async deleteFile(fileId: string): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE", token, searchParams: { supportsAllDrives: true } },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * DELETE /files/trash — PERMANENTLY delete ALL trashed files at once.
   * Irreversible; the tool layer hard-gates + previews a count. Returns 204.
   */
  async emptyTrash(): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(`${GDRIVE_API_BASE}/files/trash`, {
        method: "DELETE",
        token,
      });
    } catch (err) {
      throw mapGDriveAuthError(err, this.account);
    }
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  /**
   * GET /files/{fileId} — file metadata. `fields` defaults to the shared
   * `FILE_FIELDS` mask (so parents/owners/links come back); callers may pass a
   * custom mask. A 404 is rewritten into a NotFoundError naming the file id.
   */
  async getFile(fileId: string, fields?: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
        {
          token,
          searchParams: {
            fields: fields ?? FILE_FIELDS,
            supportsAllDrives: true,
          },
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * GET /files — list files matching an optional `q` filter (e.g.
   * `'FOLDER_ID' in parents and trashed = false` for a folder's children).
   * `pageSize` is clamped to Drive's max of 100. Always requests `LIST_FIELDS`
   * so each row carries parents/links. Returns `{ files, nextPageToken? }` with
   * `files` normalized to `[]` when Google omits it.
   */
  async listFiles(
    opts: {
      q?: string;
      pageSize?: number;
      pageToken?: string;
      driveId?: string;
      corpora?: string;
    } = {},
  ): Promise<{ files: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { fields: LIST_FIELDS, supportsAllDrives: true };
    if (opts.q !== undefined) searchParams.q = opts.q;
    if (opts.pageSize !== undefined) {
      searchParams.pageSize = clampPageSize(opts.pageSize);
    }
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    // Shared-drive listing: scoping to one drive requires driveId +
    // includeItemsFromAllDrives; corpora defaults to `drive` for that scope (L5).
    if (opts.driveId !== undefined) {
      searchParams.driveId = opts.driveId;
      searchParams.includeItemsFromAllDrives = true;
      searchParams.corpora = opts.corpora ?? "drive";
    } else if (opts.corpora !== undefined) {
      searchParams.corpora = opts.corpora;
    }
    let raw: { files?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ files?: unknown[]; nextPageToken?: string }>(
        `${GDRIVE_API_BASE}/files`,
        { token, searchParams },
      );
    } catch (err) {
      throw mapGDriveAuthError(err, this.account);
    }
    return {
      files: raw.files ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  // ===========================================================================
  // Permissions / sharing
  // ===========================================================================

  /**
   * POST /files/{fileId}/permissions — grant access. `role` + `type` are
   * required body fields; `emailAddress` (user/group) and `domain` (domain)
   * ride the body too. `sendNotificationEmail` and `transferOwnership` are
   * QUERY params. Returns the raw Permission resource shaped by
   * `PERMISSION_FIELDS`.
   */
  async createPermission(
    fileId: string,
    opts: {
      role: string;
      type: string;
      emailAddress?: string;
      domain?: string;
      allowFileDiscovery?: boolean;
      sendNotificationEmail?: boolean;
      transferOwnership?: boolean;
    },
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {
      role: opts.role,
      type: opts.type,
    };
    if (opts.emailAddress !== undefined) body.emailAddress = opts.emailAddress;
    if (opts.domain !== undefined) body.domain = opts.domain;
    // allowFileDiscovery is a Permission-resource BODY field (L3): true =
    // discoverable/searchable link, false = anyone-with-the-link only.
    if (opts.allowFileDiscovery !== undefined) {
      body.allowFileDiscovery = opts.allowFileDiscovery;
    }
    const searchParams: Record<string, string | number | boolean | undefined> =
      { fields: PERMISSION_FIELDS, supportsAllDrives: true };
    if (opts.sendNotificationEmail !== undefined) {
      searchParams.sendNotificationEmail = opts.sendNotificationEmail;
    }
    if (opts.transferOwnership !== undefined) {
      searchParams.transferOwnership = opts.transferOwnership;
    }
    try {
      return await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions`,
        { method: "POST", token, body, searchParams },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * GET /files/{fileId}/permissions — every access rule on the file. Requests
   * explicit fields (Drive omits most by default). The `permissions[]`
   * envelope is normalized to a bare array; the tool layer maps each entry.
   */
  async listPermissions(fileId: string): Promise<unknown[]> {
    const token = await this.oauthClient.getAccessToken();
    let raw: { permissions?: unknown[] };
    try {
      raw = await fetchJson<{ permissions?: unknown[] }>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions`,
        {
          token,
          searchParams: {
            fields: `permissions(${PERMISSION_FIELDS})`,
            supportsAllDrives: true,
          },
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`File \`${fileId}\` not found.`, { cause: err });
      }
      throw mapGDriveAuthError(err, this.account);
    }
    return raw.permissions ?? [];
  }

  /**
   * PATCH /files/{fileId}/permissions/{permissionId} — change a rule's role.
   * `transferOwnership` (required by Drive when elevating to `owner`) rides the
   * query string. Returns the raw Permission resource shaped by
   * `PERMISSION_FIELDS`.
   */
  async updatePermission(
    fileId: string,
    permissionId: string,
    opts: { role: string; transferOwnership?: boolean },
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { fields: PERMISSION_FIELDS, supportsAllDrives: true };
    if (opts.transferOwnership !== undefined) {
      searchParams.transferOwnership = opts.transferOwnership;
    }
    try {
      return await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}` +
          `/permissions/${encodeURIComponent(permissionId)}`,
        { method: "PATCH", token, body: { role: opts.role }, searchParams },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Permission \`${permissionId}\` not found on \`${fileId}\`.`,
          { cause: err },
        );
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }

  /**
   * DELETE /files/{fileId}/permissions/{permissionId} — revoke a share rule.
   * Returns 204 (no value). A 404 is rewritten into a NotFoundError naming the
   * permission id and file id.
   */
  async deletePermission(fileId: string, permissionId: string): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GDRIVE_API_BASE}/files/${encodeURIComponent(fileId)}` +
          `/permissions/${encodeURIComponent(permissionId)}`,
        { method: "DELETE", token, searchParams: { supportsAllDrives: true } },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Permission \`${permissionId}\` not found on \`${fileId}\`.`,
          { cause: err },
        );
      }
      throw mapGDriveAuthError(err, this.account);
    }
  }
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
      `Drive returned 403 for account ${account}. Two common causes: (1) the ` +
        `token lacks the drive scope — re-run ${reauthHintFor(account)} to ` +
        `re-consent; or (2) you're modifying a file you don't own (shared with ` +
        `you), which re-consent cannot fix — remove it from your Drive instead.`,
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
