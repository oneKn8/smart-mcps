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
import {
  AuthError,
  NotFoundError,
  PermissionError,
  UpstreamError,
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
 * Build a collision-resistant multipart boundary. Random suffix so it can
 * never appear inside arbitrary file bytes.
 */
function makeBoundary(): string {
  return (
    "gdrive_smart_boundary_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2)
  );
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
): Promise<{ path: string; bytes: number }> {
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
): Promise<{ path: string; bytes: number; mime_type: string }> {
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
