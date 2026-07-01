/**
 * Binary / multipart media layer for gdrive-smart. Implemented later by
 * implementer B.
 *
 * These functions CANNOT use core `fetchJson` — they deal in raw bytes and
 * multipart bodies, so each takes an access-token getter (see
 * `GDriveClient.accessToken()`) and performs its own `fetch`:
 *
 *   - `uploadMultipart(...)` — hand-built `multipart/related` body (a JSON
 *     metadata part + a media part joined by a boundary) POSTed to the upload
 *     host (`GDriveClient.UPLOAD_BASE`, `?uploadType=multipart`). Resumable
 *     upload for files > 5 MB is a follow-up; simple + multipart cover the MVP.
 *   - `downloadMedia(...)` — `files.get?alt=media` -> `arrayBuffer()` -> write to
 *     a caller-supplied local path. NEVER inline the bytes in a tool result.
 *   - `exportDoc(...)` — `files.export?mimeType=...` -> local path (Google-native
 *     docs/sheets/slides to pdf/docx/xlsx).
 *
 * media functions added by implementer B
 */

export {};
