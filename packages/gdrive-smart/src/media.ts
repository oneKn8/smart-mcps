/**
 * Binary / multipart media layer for gdrive-smart.
 *
 * These functions CANNOT use core `fetchJson` — they deal in raw bytes and
 * hand-built multipart bodies, so each takes an access-token getter
 * (`GDriveClient.accessToken()`) and performs its own `fetch`:
 *
 *   - `uploadMultipart(...)` — hand-built `multipart/related` body (a JSON
 *     metadata part FIRST, then the media part, joined by a boundary) POSTed
 *     to the upload host (`GDriveClient.UPLOAD_BASE`, `?uploadType=multipart`).
 *     Resumable upload for files > 5 MB is a follow-up; simple + multipart
 *     cover the MVP.
 *   - `updateContent(...)` — `PATCH .../files/{fileId}?uploadType=media`, raw
 *     bytes only (media-only content replace).
 *   - `downloadMedia(...)` — `files.get?alt=media` -> `arrayBuffer()` -> written
 *     to a caller-supplied local path. NEVER inline the bytes in a tool result.
 *   - `exportDoc(...)` — `files.export?mimeType=...` -> local path (Google-native
 *     docs/sheets/slides to pdf/docx/xlsx/...).
 *
 * Error mapping reuses `mapGDriveAuthError` (the same helper the JSON path uses)
 * so 401/403 produce the actionable re-consent message uniformly across both
 * transports. The `account` argument is threaded in as the trailing parameter
 * solely to feed that mapper (it names the account + auth CLI in the hint); the
 * token getter remains the sole auth input for the request itself.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AuthError,
  NotFoundError,
  PermissionError,
  UpstreamError,
  ValidationError,
} from "smart-mcp-core";
import { GDriveClient, mapGDriveAuthError } from "./client.js";

/** Zero-arg async access-token minter, e.g. `() => client.accessToken()`. */
export type TokenGetter = () => Promise<string>;

/** `fields` mask requested on every media create/update so the returned File
 * carries the id/links/size the slim tool shape needs. */
const MEDIA_FILE_FIELDS = "id,name,mimeType,webViewLink,size,parents";

/** Fallback content type for the media part when the caller gives none. */
const DEFAULT_MEDIA_MIME = "application/octet-stream";

/**
 * Strict RFC 6838 `type/subtype` shape. The character class already excludes
 * every control character (nothing < 0x20 or 0x7f can match), but
 * `validateMimeType` ALSO scans for control chars explicitly as belt-and-suspenders
 * so a caller-supplied `mime_type` can never inject `\r\n`-delimited headers into
 * the hand-built `multipart/related` body (C1).
 */
const MIME_TYPE_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Reject a `mime_type` that is not a clean RFC 6838 `type/subtype`, or that
 * carries ANY control character (code < 0x20 or 0x7f). Throws `ValidationError`
 * BEFORE any request body is assembled — the media Content-Type header is built
 * by raw string concatenation, so an unchecked value here is a header-injection
 * / body-corruption vector.
 */
export function validateMimeType(mime: string): void {
  for (let i = 0; i < mime.length; i++) {
    const code = mime.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new ValidationError(
        `mime_type contains a control character (code ${code}); refusing to build the upload body.`,
      );
    }
  }
  if (!MIME_TYPE_RE.test(mime)) {
    throw new ValidationError(
      `Invalid mime_type \`${mime}\` — expected an RFC 6838 'type/subtype' value (e.g. 'image/jpeg').`,
    );
  }
}

/**
 * Reject any local/dest path containing a `..` traversal segment (M4). Splits
 * on both separators so `a/../b`, `..\\x`, and a lone `..` are all caught while
 * an innocuous filename like `my..file.txt` is allowed.
 */
export function assertNoTraversal(p: string): void {
  if (p.split(/[/\\]/).includes("..")) {
    throw new ValidationError(
      `Path must not contain a '..' traversal segment: \`${p}\``,
    );
  }
}

/**
 * Refuse to clobber an existing destination file unless `overwrite` is true
 * (M4). Fails fast BEFORE any network fetch so a download/export never silently
 * destroys local data.
 */
function assertWritableDest(destPath: string, overwrite: boolean): void {
  if (!overwrite && existsSync(destPath)) {
    throw new ValidationError(
      `Refusing to overwrite existing file \`${destPath}\` — pass overwrite:true to replace it.`,
    );
  }
}

/**
 * Build a multipart boundary. The random UUID suffix makes an accidental
 * collision with the file's own bytes cryptographically negligible.
 */
function makeBoundary(): string {
  return `gdrive_smart_boundary_${randomUUID()}`;
}

/**
 * POST a `multipart/related` create to the upload host. The body is assembled
 * as a `Buffer` (text preamble + raw file bytes + text epilogue) so binary
 * content is never corrupted by string encoding. Metadata part comes first.
 */
export async function uploadMultipart(
  getToken: TokenGetter,
  opts: {
    name: string;
    parents?: string[];
    mimeType?: string;
    localPath: string;
  },
  account: string,
): Promise<Record<string, unknown>> {
  // Defense-in-depth: validate BEFORE any read / body assembly. `mime_type` is
  // concatenated raw into the media-part Content-Type header, so an unchecked
  // value is a header-injection vector (C1); `local_path` traversal is refused (M4).
  assertNoTraversal(opts.localPath);
  if (opts.mimeType !== undefined) validateMimeType(opts.mimeType);

  const bytes = await readFile(opts.localPath);
  const mediaMime = opts.mimeType ?? DEFAULT_MEDIA_MIME;

  const metadata: Record<string, unknown> = { name: opts.name };
  if (opts.parents !== undefined) metadata.parents = opts.parents;
  if (opts.mimeType !== undefined) metadata.mimeType = opts.mimeType;

  const boundary = makeBoundary();
  const preamble =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaMime}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(preamble, "utf8"),
    bytes,
    Buffer.from(epilogue, "utf8"),
  ]);

  const token = await getToken();
  const url = `${GDriveClient.UPLOAD_BASE}?uploadType=multipart&fields=${MEDIA_FILE_FIELDS}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw await mediaError(res, "POST", url, account);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * PATCH new bytes onto an existing file via `uploadType=media` (content-only
 * replace; metadata is left untouched). Reversible through Drive's revision
 * history, so it is intentionally NOT confirm-gated.
 */
export async function updateContent(
  getToken: TokenGetter,
  fileId: string,
  opts: { localPath: string; mimeType?: string },
  account: string,
): Promise<Record<string, unknown>> {
  // Same header-injection (C1) + traversal (M4) guards as the multipart path:
  // `mime_type` rides the raw Content-Type header here too.
  assertNoTraversal(opts.localPath);
  if (opts.mimeType !== undefined) validateMimeType(opts.mimeType);

  const bytes = await readFile(opts.localPath);
  const token = await getToken();
  const url =
    `${GDriveClient.UPLOAD_BASE}/${encodeURIComponent(fileId)}` +
    `?uploadType=media&fields=${MEDIA_FILE_FIELDS}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": opts.mimeType ?? DEFAULT_MEDIA_MIME,
    },
    body: bytes,
  });
  if (!res.ok) throw await mediaError(res, "PATCH", url, account, fileId);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * GET `files.get?alt=media` (blob content) and write the raw bytes to
 * `destPath`. Returns only the local path + byte count — the bytes themselves
 * are never returned inline.
 */
export async function downloadMedia(
  getToken: TokenGetter,
  fileId: string,
  destPath: string,
  account: string,
  overwrite = false,
): Promise<{ path: string; bytes: number }> {
  assertNoTraversal(destPath);
  assertWritableDest(destPath, overwrite);
  const token = await getToken();
  const url = `${GDriveClient.API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await mediaError(res, "GET", url, account, fileId);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return { path: destPath, bytes: buf.byteLength };
}

/**
 * GET `files.export?mimeType=<target>` (Google-native doc -> chosen format) and
 * write the exported bytes to `destPath`. Returns the local path, byte count,
 * and the export MIME type — never the bytes inline. Export is capped at 10 MB
 * by Drive.
 */
export async function exportDoc(
  getToken: TokenGetter,
  fileId: string,
  exportMimeType: string,
  destPath: string,
  account: string,
  overwrite = false,
): Promise<{ path: string; bytes: number; mime_type: string }> {
  assertNoTraversal(destPath);
  assertWritableDest(destPath, overwrite);
  const token = await getToken();
  const url =
    `${GDriveClient.API_BASE}/files/${encodeURIComponent(fileId)}/export` +
    `?mimeType=${encodeURIComponent(exportMimeType)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await mediaError(res, "GET", url, account, fileId);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return { path: destPath, bytes: buf.byteLength, mime_type: exportMimeType };
}

// ============================================================================
// Error mapping (raw-fetch analogue of fetchJson's mapErrorResponse)
// ============================================================================

/** Read a response body as text, tolerating a body that fails to read. */
async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Turn a non-2xx media response into the right typed error, mirroring the
 * JSON path so callers see uniform behavior:
 *   - 404 (with a known file id) -> NotFoundError naming the file.
 *   - 403 ownership (`insufficientFilePermissions`) -> PermissionError
 *     (re-consent never fixes it — matches core `http.ts`).
 *   - 401 / other 403 -> routed through `mapGDriveAuthError` for the actionable
 *     re-auth message (the synthetic AuthError carries a `→ <status>` marker so
 *     the mapper classifies it exactly as it would a `fetchJson` error).
 *   - anything else -> UpstreamError with status + body text.
 */
async function mediaError(
  res: { status: number; text: () => Promise<string> },
  method: string,
  url: string,
  account: string,
  fileId?: string,
): Promise<unknown> {
  const bodyText = await safeText(res);
  const status = res.status;
  const message = `${method} ${url} → ${status}: ${bodyText}`;

  if (status === 404 && fileId !== undefined) {
    return new NotFoundError(`File \`${fileId}\` not found.`, {
      detail: bodyText,
    });
  }
  if (status === 403 && isResourcePermissionDenied(bodyText)) {
    return new PermissionError(
      "You don't have permission on this resource — most likely you don't own it. " +
        "Items shared with you (that you don't own) can't be modified via the API.",
      { detail: bodyText },
    );
  }
  // A Google-native doc (Docs/Sheets/Slides) can't be fetched with alt=media —
  // Drive returns 403 `fileNotDownloadable`. That is NOT a scope/auth problem, so
  // route it to a clear "use export_file" error instead of a misleading re-auth
  // hint (M3).
  if (status === 403 && isFileNotDownloadable(bodyText)) {
    return new ValidationError(
      "This is a Google-native document (Doc/Sheet/Slide) and cannot be downloaded " +
        "directly — use export_file to convert it to a downloadable format instead.",
      { detail: bodyText },
    );
  }
  if (status === 401 || status === 403) {
    return mapGDriveAuthError(new AuthError(message, { detail: bodyText }), account);
  }
  return new UpstreamError(message, { detail: bodyText });
}

/** Same ownership-403 markers core `http.ts` keys on. */
function isResourcePermissionDenied(bodyText: string): boolean {
  const text = bodyText.toLowerCase();
  return (
    text.includes("insufficientfilepermissions") ||
    text.includes("does not have sufficient permission")
  );
}

/** Drive's 403 marker for a native doc fetched via alt=media (M3). */
function isFileNotDownloadable(bodyText: string): boolean {
  return bodyText.toLowerCase().includes("filenotdownloadable");
}
