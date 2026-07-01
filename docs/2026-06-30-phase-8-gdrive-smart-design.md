# Phase 8 design: gdrive-smart (Google Drive API manager)

Date: 2026-06-30
Status: approved (Santo: "New gdrive-smart"), build in progress

Closes the "organize Google Drive" gap left by Phase 7. The existing
`drive-smart` is a LOCAL-DISK scanner (filesystem + GVfs mounts, no Drive API) —
it stays untouched. `gdrive-smart` is a NEW, separate MCP that wraps the Google
Drive REST API v3 for real file management: folders, move/copy/rename, trash
lifecycle, upload/download/export, and sharing.

Verified API reference (read before implementing):
`docs/research/2026-06-30-drive-api-write-reference.md`.

Conventions inherited from the monorepo `CLAUDE.md` and `calendar-smart` (the
canonical Google-API template). `gdrive-smart` follows the `client.ts` REST
pattern (NOT drive-smart's index-scan model). Only what's new/non-obvious below.

## 1. Auth, scope, identity

- API base (JSON): `https://www.googleapis.com/drive/v3`
- Upload base: `https://www.googleapis.com/upload/drive/v3/files`
- Token file suffix: `.gdrive.json`. Scope: `https://www.googleapis.com/auth/drive`
  (FULL/restricted — required to touch files the app did not create; `drive.file`
  is a dead end for a general manager). Auth CLI: `gdrive-smart-auth`.
- Identity: single-account, `DEFAULT_IDENTITY = "your-account"` (same pattern as
  the others). Reuses `smart-mcp-core` `GoogleOAuthClient`.
- File identity: real Drive `fileId`s. gdrive-smart does NOT reuse drive-smart's
  synthetic `rootId:relpath` ids (different domain). Callers resolve a
  name -> fileId via `list` / `get` before mutating; every write tool takes a
  real `file_id`.

## 2. Architecture: client split (so media never pollutes the JSON path)

- `src/client.ts` — `GDriveClient`: all JSON operations via core `fetchJson`
  (create/update/copy/delete/list/get/permissions). Auth wiring + error mapping.
- `src/media.ts` — standalone media functions that CANNOT use `fetchJson`
  (binary / multipart), each taking an access-token getter:
  - `uploadMultipart(...)` — hand-built `multipart/related` body (JSON metadata
    part + media part + boundary) to the upload host. Resumable fallback noted as
    a follow-up for >5 MB; simple+multipart cover the MVP.
  - `downloadMedia(...)` — `files.get?alt=media` -> `arrayBuffer()` -> write to a
    caller-supplied local path. NEVER inline bytes in a tool result.
  - `exportDoc(...)` — `files.export?mimeType=...` -> local path (Google-native
    docs/sheets/slides to pdf/docx/xlsx).
- `fields` is mandatory on get/list/create to return parents/owners/links; every
  method sets an explicit `fields` mask and maps to a slim shape.
- `files.list` pageSize max is 100 (verified). Paginate via `nextPageToken`.

## 3. Tool set (~24) — snake_case, <=15-token descriptions

Create/organize:
- `create_folder` (mimeType folder; optional parent)
- `create_shortcut` (shortcutDetails.targetId)
- `generate_ids`
- `rename` (files.update name)
- `move` (files.update addParents/removeParents query params, empty body)
- `copy` (files.copy — files only, reject folders with a clear message)
- `star` / set starred + other metadata via `update_metadata` (name/description/starred)
- `list` (folder children via q="'ID' in parents and trashed=false", + free q)
- `get` (metadata with explicit fields)

Lifecycle (destructive gating per §4):
- `trash` (files.update trashed=true — REVERSIBLE, the default "delete")
- `restore` (trashed=false)
- `delete` (files.delete — PERMANENT, hard-gated)
- `empty_trash` (hard-gated, dry_run default true)

Media:
- `upload` (local file -> new Drive file, multipart)
- `update_content` (replace an existing file's bytes)
- `download` (blob -> local path)
- `export` (Google-native -> local path, chosen mimeType)

Sharing (sensitive, gated):
- `share` (permissions.create: role reader/writer/commenter/owner, type
  user/group/domain/anyone; sendNotificationEmail) — CONFIRM-gated; `anyone`
  (link-public) and any `owner`/transferOwnership path HARD-gated with an
  explicit exposure preview.
- `list_permissions`
- `update_permission`
- `unshare` (permissions.delete)

Optional / deferred (logged, not silently dropped): `list_revisions` /
`keep_revision`, standalone `transfer_ownership` (folded into `share` gating),
shared-drive (corpora/driveId) params on `list`, resumable upload for >5 MB.

## 4. Safety model

- REVERSIBLE by default: the "delete" a user reaches for is `trash` (30-day
  recovery). `restore` undoes it. No confirm needed for trash (reversible), but
  the description says "trash (recoverable)".
- HARD-GATED (`guardDestructive`, confirm required, explicit preview):
  - `delete` (permanent, irreversible) — preview names the file + "cannot be undone".
  - `empty_trash` — `dry_run` default true, lists trashed files first.
  - `share` to `type: anyone` (makes it link-accessible to the world) — preview
    states public exposure.
  - `share`/`update_permission` with `role: owner` or `transferOwnership` —
    preview states ownership change (you may lose control of the file).
- `move`, `rename`, `copy`, `star`, `create_folder`, `update_metadata`,
  `update_content` are reversible-enough and not gated (normal writes).
- Every write tool takes a real `file_id`; a bad id surfaces core's `NotFoundError`
  with a clear message. 403 ownership -> `PermissionError` (re-consent won't help).

## 5. Build plan (subagent-driven)

1. Scaffold gdrive-smart (config/context/server/tools skeleton, `client.ts` auth
   wiring + base URLs, `media.ts` stub, `gdrive-smart-auth` CLI, `./client`
   export, README). One `npm install`, build+typecheck green. Commit.
2. Parallel implementers (disjoint files):
   - A: `client.ts` (JSON methods) + create/organize/lifecycle/read/sharing tools + tests.
   - B: `media.ts` + upload/update_content/download/export tools + tests.
3. Adversarial cross-verify (focus: destructive gating correctness, multipart
   wire format, binary handling not inlined, share-exposure gating, fields masks,
   pagination at 100, folder-vs-file copy rejection).
4. Live-test (SAFE, self-cleaning): create_folder -> create a doc/upload a small
   file into it -> get/list to verify -> rename -> move -> trash -> restore ->
   delete (permanent) -> confirm gone. Sharing tested with a throwaway file to a
   single address WITHOUT notification, then unshare, then delete.
5. Register (install-clients.sh), auth CLI (one more consent, durable in
   Production), clean atomic commit history, memory + handoff.

## Done definition
Behavior in code, integrated, unit/typecheck/boot verified, adversarially
cross-verified, and LIVE-verified end-to-end (Drive is safe to create/delete, so
unlike Phase 7 the write path IS live-tested here). Honest labels throughout.
