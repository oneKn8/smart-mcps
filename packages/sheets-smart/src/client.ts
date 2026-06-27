import {
  AuthError,
  NotFoundError,
  ValidationError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_TOKEN_FILE_SUFFIX = ".sheets.json";
const SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced by
 * this client. Mirrors the CLI users actually run:
 *   `node packages/sheets-smart/dist/bin/sheets-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/sheets-smart/dist/bin/sheets-smart-auth.js ${account}`;
}

export type SheetsClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth client
   * resolves `process.env.HOME` lazily on first use. Tests pass a tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the client
   * builds one against the sheets token-jar slot (`<account>.sheets.json`) on
   * construction.
   */
  oauthClient?: GoogleOAuthClient;
};

// --- Response shapes (slim — only what the tool layer reads) ---------------

export type Spreadsheet = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: unknown;
  sheets?: unknown[];
  namedRanges?: unknown[];
};

export type ValueRange = {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
};

export type UpdateValuesResponse = {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
};

export type AppendValuesResponse = {
  spreadsheetId?: string;
  tableRange?: string;
  updates?: UpdateValuesResponse;
};

export type BatchUpdateValuesResponse = {
  spreadsheetId?: string;
  totalUpdatedRows?: number;
  totalUpdatedColumns?: number;
  totalUpdatedCells?: number;
  totalUpdatedSheets?: number;
  responses?: unknown[];
};

export type ClearValuesResponse = {
  spreadsheetId?: string;
  clearedRange?: string;
};

export type BatchUpdateSpreadsheetResponse = {
  spreadsheetId?: string;
  replies?: unknown[];
  updatedSpreadsheet?: unknown;
};

export type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
};

export type DrivePermission = {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
};

export type ListFilesResult = {
  files: unknown[];
  nextPageToken?: string;
};

/**
 * REST client for Google Sheets API v4 + Google Drive API v3. The constructor
 * builds (but does not read) the OAuth client; the token file is opened lazily
 * on the first method call. Sheets operations hit `sheets.googleapis.com/v4`;
 * file lifecycle / sharing operations hit `www.googleapis.com/drive/v3`.
 */
export class SheetsClient {
  static readonly TOKEN_FILE_SUFFIX = SHEETS_TOKEN_FILE_SUFFIX;
  static readonly SCOPES = SHEETS_SCOPES;

  private readonly oauth: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: SheetsClientOpts = {},
  ) {
    this.oauth =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: SHEETS_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: SHEETS_SCOPES[0],
      });
  }

  /**
   * Account identifier this client is bound to. Mirrors the basename of the
   * token file under `~/.santo-agent/oauth/`. Read-only.
   */
  getAccount(): string {
    return this.account;
  }

  // =========================================================================
  // Sheets v4
  // =========================================================================

  /** POST /spreadsheets — create a spreadsheet from a full `Spreadsheet` body. */
  async createSpreadsheet(body: Record<string, unknown>): Promise<Spreadsheet> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<Spreadsheet>(`${SHEETS_API_BASE}/spreadsheets`, {
        method: "POST",
        token,
        body,
      });
    } catch (err) {
      throw mapSheetsAuthError(err, this.account);
    }
  }

  /** GET /spreadsheets/{id} — metadata, optionally narrowed with a fields mask. */
  async getSpreadsheet(
    id: string,
    opts: { fields?: string; ranges?: string[]; includeGridData?: boolean } = {},
  ): Promise<Spreadsheet> {
    const token = await this.oauth.getAccessToken();
    const url = new URL(`${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}`);
    if (opts.fields !== undefined) url.searchParams.set("fields", opts.fields);
    if (opts.includeGridData !== undefined) {
      url.searchParams.set("includeGridData", String(opts.includeGridData));
    }
    if (opts.ranges !== undefined) {
      for (const r of opts.ranges) url.searchParams.append("ranges", r);
    }
    try {
      return await fetchJson<Spreadsheet>(url.toString(), { token });
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** GET /spreadsheets/{id}/values/{range} — read a value range. */
  async getValues(
    id: string,
    range: string,
    opts: { valueRenderOption?: string; majorDimension?: string } = {},
  ): Promise<ValueRange> {
    const token = await this.oauth.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {};
    if (opts.valueRenderOption !== undefined) {
      searchParams.valueRenderOption = opts.valueRenderOption;
    }
    if (opts.majorDimension !== undefined) {
      searchParams.majorDimension = opts.majorDimension;
    }
    try {
      return await fetchJson<ValueRange>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}` +
          `/values/${encodeURIComponent(range)}`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** PUT /spreadsheets/{id}/values/{range}?valueInputOption= — overwrite a range. */
  async updateValues(
    id: string,
    range: string,
    values: unknown[][],
    valueInputOption: string,
  ): Promise<UpdateValuesResponse> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<UpdateValuesResponse>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}` +
          `/values/${encodeURIComponent(range)}`,
        {
          method: "PUT",
          token,
          searchParams: { valueInputOption },
          body: { range, values },
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** POST /spreadsheets/{id}/values/{range}:append — append rows after a table. */
  async appendValues(
    id: string,
    range: string,
    values: unknown[][],
    valueInputOption: string,
    insertDataOption: string,
  ): Promise<AppendValuesResponse> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<AppendValuesResponse>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}` +
          `/values/${encodeURIComponent(range)}:append`,
        {
          method: "POST",
          token,
          searchParams: { valueInputOption, insertDataOption },
          body: { range, values },
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** POST /spreadsheets/{id}/values:batchUpdate — write multiple ranges at once. */
  async batchUpdateValues(
    id: string,
    data: { range: string; values: unknown[][] }[],
    valueInputOption: string,
  ): Promise<BatchUpdateValuesResponse> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<BatchUpdateValuesResponse>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}/values:batchUpdate`,
        {
          method: "POST",
          token,
          body: { valueInputOption, data },
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** POST /spreadsheets/{id}/values/{range}:clear — clear values (keeps format). */
  async clearValues(id: string, range: string): Promise<ClearValuesResponse> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<ClearValuesResponse>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}` +
          `/values/${encodeURIComponent(range)}:clear`,
        { method: "POST", token, body: {} },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** POST /spreadsheets/{id}:batchUpdate — structural/format requests, atomic. */
  async batchUpdate(
    id: string,
    requests: unknown[],
  ): Promise<BatchUpdateSpreadsheetResponse> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<BatchUpdateSpreadsheetResponse>(
        `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`,
        { method: "POST", token, body: { requests } },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  // =========================================================================
  // Drive v3
  // =========================================================================

  /** GET /files — search files (used to list spreadsheets via a `q` query). */
  async listFiles(
    q: string,
    opts: {
      pageSize?: number;
      pageToken?: string;
      orderBy?: string;
      fields?: string;
    } = {},
  ): Promise<ListFilesResult> {
    const token = await this.oauth.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {
      q,
    };
    if (opts.pageSize !== undefined) searchParams.pageSize = opts.pageSize;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    if (opts.orderBy !== undefined) searchParams.orderBy = opts.orderBy;
    if (opts.fields !== undefined) searchParams.fields = opts.fields;
    let raw: { files?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ files?: unknown[]; nextPageToken?: string }>(
        `${DRIVE_API_BASE}/files`,
        { token, searchParams },
      );
    } catch (err) {
      throw mapSheetsAuthError(err, this.account);
    }
    return {
      files: raw.files ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /** POST /files — create a Drive file (e.g. a spreadsheet inside a folder). */
  async createFile(body: Record<string, unknown>): Promise<DriveFile> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<DriveFile>(`${DRIVE_API_BASE}/files`, {
        method: "POST",
        token,
        body,
      });
    } catch (err) {
      throw mapSheetsAuthError(err, this.account);
    }
  }

  /**
   * PATCH /files/{id} — partial update. `addParents` / `removeParents` ride on
   * the query string (Drive requires them there, not in the body).
   */
  async updateFile(
    id: string,
    body: Record<string, unknown>,
    opts: { addParents?: string; removeParents?: string } = {},
  ): Promise<DriveFile> {
    const token = await this.oauth.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {};
    if (opts.addParents !== undefined) searchParams.addParents = opts.addParents;
    if (opts.removeParents !== undefined) {
      searchParams.removeParents = opts.removeParents;
    }
    try {
      return await fetchJson<DriveFile>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          token,
          body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** PATCH /files/{id} {trashed:true} — move to trash (recoverable 30 days). */
  async trashFile(id: string): Promise<DriveFile> {
    const token = await this.oauth.getAccessToken();
    try {
      return await fetchJson<DriveFile>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`,
        { method: "PATCH", token, body: { trashed: true } },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** DELETE /files/{id} — permanent, non-recoverable delete. */
  async deleteFile(id: string): Promise<void> {
    const token = await this.oauth.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** POST /files/{id}/permissions — grant access (share). */
  async createPermission(
    id: string,
    body: Record<string, unknown>,
    opts: { sendNotificationEmail?: boolean } = {},
  ): Promise<DrivePermission> {
    const token = await this.oauth.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {};
    if (opts.sendNotificationEmail !== undefined) {
      searchParams.sendNotificationEmail = opts.sendNotificationEmail;
    }
    try {
      return await fetchJson<DrivePermission>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}/permissions`,
        {
          method: "POST",
          token,
          body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
  }

  /** GET /files/{id}?fields=webViewLink — the shareable link. */
  async getWebViewLink(id: string): Promise<string> {
    const token = await this.oauth.getAccessToken();
    let file: DriveFile;
    try {
      file = await fetchJson<DriveFile>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`,
        { token, searchParams: { fields: "webViewLink" } },
      );
    } catch (err) {
      throw mapSheetsNotFound(err, id, this.account);
    }
    return typeof file.webViewLink === "string" ? file.webViewLink : "";
  }
}

/**
 * Like `mapSheetsAuthError`, but first rewrites a 404 into a NotFoundError that
 * names the spreadsheet/file id, mirroring calendar-smart's per-resource 404
 * handling.
 */
function mapSheetsNotFound(err: unknown, id: string, account: string): unknown {
  if (err instanceof NotFoundError) {
    return new NotFoundError(`Spreadsheet \`${id}\` not found.`, { cause: err });
  }
  return mapSheetsAuthError(err, account);
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the `sheets-smart-auth` CLI, and enrich Google's 400
 * bodies with the upstream error reason. Other error types pass through.
 */
function mapSheetsAuthError(err: unknown, account: string): unknown {
  if (err instanceof NotFoundError) return err;
  if (err instanceof ValidationError) {
    const detail = (err as { detail?: unknown }).detail;
    const reason = extractGoogleErrorReason(detail);
    if (reason) {
      return new ValidationError(`${err.message} — ${reason}`, { detail, cause: err });
    }
    return err;
  }
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    if (
      msg.includes("accessNotConfigured") ||
      msg.includes("SERVICE_DISABLED") ||
      msg.includes("has not been used in project")
    ) {
      return new AuthError(
        `Google Sheets or Drive API is not enabled on your Cloud project. ` +
          `Enable both at https://console.developers.google.com/apis/library ` +
          `(Google Sheets API + Google Drive API), then wait ~30s for propagation.`,
        { cause: err },
      );
    }
    return new AuthError(
      `sheets token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the Sheets + Drive scopes`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `sheets token rejected for account ${account}; ` +
        `re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}

/**
 * Extract Google's human-readable error reason from the parsed body the core
 * http layer attached as `.detail`. Standard shape:
 * `{ error: { errors: [{ message, reason }], message, code } }`.
 */
function extractGoogleErrorReason(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { error?: unknown };
  const errBlock = d.error;
  if (typeof errBlock !== "object" || errBlock === null) return null;
  const eb = errBlock as { message?: unknown; errors?: unknown };
  if (Array.isArray(eb.errors) && eb.errors.length > 0) {
    const first = eb.errors[0] as { message?: unknown; reason?: unknown };
    if (typeof first.message === "string" && first.message.length > 0) {
      return first.message;
    }
  }
  if (typeof eb.message === "string" && eb.message.length > 0) {
    return eb.message;
  }
  return null;
}
