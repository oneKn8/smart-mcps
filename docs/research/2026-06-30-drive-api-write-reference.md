# Google Drive API (drive/v3) — Verified WRITE / Organize / Share / Media Reference

> Researched 2026-06-30. Every endpoint, parameter, scope, and shape below is sourced from official
> Google documentation (`developers.google.com/drive/api/...` and its canonical mirror
> `developers.google.com/workspace/drive/api/...`; both serve identical content). Nothing is guessed.
> Focus: the WRITE / organize / share / media surface needed to turn `drive-smart` into a full Drive
> manager. The read/metadata side is treated only where it supports writes.

**Service (JSON) endpoint:** `https://www.googleapis.com/drive/v3`
**Upload endpoint (separate host path):** `https://www.googleapis.com/upload/drive/v3/files`

Primary sources:
- files.create — https://developers.google.com/drive/api/reference/rest/v3/files/create
- files.update — https://developers.google.com/drive/api/reference/rest/v3/files/update
- files.copy — https://developers.google.com/drive/api/reference/rest/v3/files/copy
- files.delete — https://developers.google.com/drive/api/reference/rest/v3/files/delete
- files.emptyTrash — https://developers.google.com/drive/api/reference/rest/v3/files/emptyTrash
- files.get — https://developers.google.com/drive/api/reference/rest/v3/files/get
- files.list — https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- files.generateIds — https://developers.google.com/drive/api/reference/rest/v3/files/generateIds
- files.export — https://developers.google.com/drive/api/reference/rest/v3/files/export
- Upload guide — https://developers.google.com/drive/api/guides/manage-uploads
- Download/export guide — https://developers.google.com/drive/api/guides/manage-downloads
- Export MIME types — https://developers.google.com/drive/api/guides/ref-export-formats
- Folders (create/move) — https://developers.google.com/drive/api/guides/folder
- Trash/delete — https://developers.google.com/drive/api/guides/delete
- Shortcuts — https://developers.google.com/drive/api/guides/shortcuts
- Search (q syntax) — https://developers.google.com/drive/api/guides/search-files
- permissions.create/list/get/update/delete — https://developers.google.com/drive/api/reference/rest/v3/permissions/*
- revisions.list/get/update/delete — https://developers.google.com/drive/api/reference/rest/v3/revisions/*
- OAuth scopes — https://developers.google.com/drive/api/guides/api-specific-auth
- Usage limits — https://developers.google.com/workspace/drive/api/guides/limits

---

## 0. Critical integration reality (read this before building)

**The existing `drive-smart` "read side" does NOT use the Drive REST API.** It is a *local filesystem
indexer* over mounted Google Drive desktop-sync roots (GVfs mounts, "Shared with me", plus any
configured local folders). Evidence in `packages/drive-smart/src/`: `roots.ts`/`scan.ts` use
`node:fs` (`readdirSync`/`statSync`); `context.ts` wires `discoverRoots`+`scanRoots`+`loadIndex`; a
repo-wide grep for `googleapis|oauth|access_token|drive/v3|Bearer` returns nothing. File IDs are
synthetic (`` `${rootId}:${relativePath}` `` in `scan.ts`).

Consequences for the write side (all load-bearing):

1. **New auth layer required.** There is no Drive OAuth client to extend. You must add an OAuth token
   source (mirror the `email-smart` pattern that wraps `~/.santo-agent/` OAuth) carrying the **full
   `https://www.googleapis.com/auth/drive` scope** (§7).
2. **ID mismatch.** The scanner's `rootId:relpath` IDs are NOT real Drive `fileId`s. Every API write
   tool needs a real Drive `fileId`, which comes from an API `files.list`/`files.get` (§2), not the
   local index. Plan a resolver (name/path -> API `fileId`) or an API-native listing tool.
3. This is the biggest wrinkle, bigger than the two flagged in §11. The write side is effectively a
   **new sub-integration** sharing only the package name and the `drive_` tool prefix.

---

## 1. Base URLs, resources, and the two hosts

| Concern | Value |
|---|---|
| Metadata / JSON operations | `https://www.googleapis.com/drive/v3/...` |
| Uploads (bytes) | `https://www.googleapis.com/upload/drive/v3/files` (requires `uploadType`) |
| Downloads (bytes) | same metadata host, `files.get?alt=media` / `files.export` |
| Resources in scope here | `files`, `permissions`, `revisions` (+ `about`, `drives`, `changes` for read/quotas) |

Universal query params on most `files.*` write methods: `supportsAllDrives` (bool; set **true** if you
ever touch shared drives), `includeLabels`, `includePermissionsForView` (only value: `published`).
`supportsTeamDrives`, `enforceSingleParent` are **deprecated** — do not use.

---

## 2. Files: lifecycle & organize

| Method | Verb + Path | Key params / body | Response |
|---|---|---|---|
| **create** (folder or metadata-only) | `POST /files` | body = File resource | File |
| **create** (with bytes) | `POST /upload/drive/v3/files?uploadType=media\|multipart\|resumable` | see §3 | File |
| **update** (rename/move/star/trash/describe) | `PATCH /files/{fileId}` | query `addParents`,`removeParents`; body = partial File | File |
| **update** (replace bytes) | `PATCH /upload/drive/v3/files/{fileId}?uploadType=...` | see §3 | File |
| **copy** | `POST /files/{fileId}/copy` | body = File (set `name`,`parents`) | File (the copy) |
| **delete** (PERMANENT) | `DELETE /files/{fileId}` | query `supportsAllDrives` | empty `{}` |
| **emptyTrash** | `DELETE /files/trash` | query `driveId` | empty `{}` |
| **get** (metadata) | `GET /files/{fileId}` | query `fields`, `alt` | File (or bytes if `alt=media`) |
| **list** | `GET /files` | query `q`,`corpora`,`orderBy`,`pageSize`,`pageToken`,`spaces`,`driveId`,`fields` | `{files[], nextPageToken, incompleteSearch, kind}` |
| **generateIds** | `GET /files/generateIds` | query `count`,`space`,`type` | `{ids[], space, kind}` |

### 2.1 Create a folder
A folder *is* a file whose `mimeType` is `application/vnd.google-apps.folder` (source: folder guide).
```jsonc
POST https://www.googleapis.com/drive/v3/files
{ "name": "Invoices", "mimeType": "application/vnd.google-apps.folder", "parents": ["PARENT_ID"] }
```
- `parents` is an **array of parent folder IDs**. Set on create to place the item. A file may have
  **only one parent** ("Specifying multiple parents isn't supported"). Omit `parents` -> lands in My
  Drive root. The alias **`root`** refers to the root folder anywhere a file ID is accepted.
- Native-doc mimeTypes you can create empty this way: `application/vnd.google-apps.document` (Docs),
  `...spreadsheet` (Sheets), `...presentation` (Slides), `...folder`, `...shortcut` (§2.9).

### 2.2 Update = PATCH with patch semantics
`files.update` is **PATCH**. Only the fields present in the body change; omitted fields are untouched.
Common editable File fields: `name` (rename), `starred` (bool), `trashed` (bool — §2.5), `description`,
`mimeType`, `properties`/`appProperties`, `folderColorRgb`, `contentHints`.
```jsonc
PATCH /files/{fileId}     // rename + star + describe in one call
{ "name": "Q3 report.pdf", "starred": true, "description": "final" }
```

### 2.3 MOVE via addParents / removeParents (query params, NOT body)
Moving is done with the **`addParents`** and **`removeParents`** query parameters (each a
**comma-separated list of parent IDs**), typically with an **empty body**:
```
1) GET  /files/{fileId}?fields=parents          -> read current parent(s)
2) PATCH /files/{fileId}?addParents=NEW_FOLDER_ID&removeParents=OLD_FOLDER_ID   (empty body)
```
Because a file has one parent, a "move" = add the destination + remove the source. To find the source,
`files.get` with `fields=parents` first. `addParents` alone (no remove) adds a second parent only where
multi-parenting still exists (legacy/shared-drive edge); for My Drive, always pair add+remove.

### 2.4 Copy
`POST /files/{fileId}/copy`. Body is a File resource, so you may set `name` and `parents` to copy into a
different folder under a new name. **Copy applies to individual files only, not folders** ("Copying
files into multiple folders is no longer supported. Use shortcuts instead."). To "copy a folder" you
must create a folder and recursively copy children yourself. Params: `ignoreDefaultVisibility`,
`keepRevisionForever`, `ocrLanguage`, `supportsAllDrives`, `includePermissionsForView`, `includeLabels`.

### 2.5 Trash vs permanent delete (the key safety distinction)
| Operation | Effect | Reversible? |
|---|---|---|
| `files.update` body `{"trashed": true}` | moves to Trash | **Yes** — restore with `{"trashed": false}`; auto-purged after **30 days** |
| `files.delete` (`DELETE /files/{fileId}`) | **permanently deletes, bypassing Trash**; if a folder, "all descendants owned by the user are also deleted" | **No** |
| `files.emptyTrash` (`DELETE /files/trash`) | permanently deletes **all** trashed files at once | **No** |

Only the file **owner** can trash/delete; non-owners get `insufficientFilePermissions`
(the repo's `http.ts` already maps Drive 403 `insufficientFilePermissions` -> `PermissionError`).
Relevant read fields: `trashed`, `explicitlyTrashed`, `trashedTime`/`trashingUser` (shared drives).
**Recommendation for an MCP: default "delete" to trashing (`trashed:true`); expose true
`files.delete`/`emptyTrash` only behind an explicit confirm gate (§9).**

### 2.6 Restore from trash
`PATCH /files/{fileId}` body `{"trashed": false}`. Works within the 30-day window.

### 2.7 files.get and the `fields` parameter (why it matters)
`GET /files/{fileId}`. By default Drive returns only a **subset** of File fields. You must request
fields explicitly via the `fields` system parameter or you will not receive `parents`, `owners`,
`webViewLink`, `size`, `md5Checksum`, `shortcutDetails`, etc.
```
GET /files/{fileId}?fields=id,name,mimeType,parents,owners(displayName,emailAddress),webViewLink,webContentLink,size,modifiedTime,trashed,shortcutDetails
```
For `files.list`, the analogous form nests under `files(...)`:
`fields=nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)`. `alt` (default `json`);
`alt=media` turns this into a **binary download** (§4). Other params: `acknowledgeAbuse` (only with
`alt=media`), `supportsAllDrives`, `includePermissionsForView`, `includeLabels`.

### 2.8 files.list — list a folder's children and shared-drive params
`GET /files`. To list one folder's live children:
```
q = "'FOLDER_ID' in parents and trashed = false"
```
Params (exact wording from the canonical page):
- **`pageSize`** — "The maximum number of files to return per page… **The maximum value is 100; values
  above 100 are changed to 100.**" Default: 100 for shared drives; entire list for non-shared drives.
  **(Note: this is 100, not 1000. The older 1000 max no longer applies — paginate with `pageToken`.)**
- `q` — filter; syntax below.
- `orderBy` — comma list of: `createdTime, folder, modifiedByMeTime, modifiedTime, name, name_natural,
  quotaBytesUsed, recency, sharedWithMeTime, starred, viewedByMeTime` (append ` desc` to reverse).
- `spaces` — comma list of `drive` and/or `appDataFolder`.
- **Shared drives:** `corpora` (`user`|`drive`|`domain`|`allDrives`), `driveId`,
  `includeItemsFromAllDrives=true`, `supportsAllDrives=true`. Use `corpora=drive`+`driveId` to scope to
  one shared drive; `allDrives` is discouraged for perf.
- Response: `{ files[], nextPageToken, incompleteSearch, kind:"drive#fileList" }`.

**`q` operators (search-files guide):** `contains, =, !=, <, <=, >, >=, in, and, or, not, has`.
String literals use **single quotes**; escape `'` and `\` with a backslash
(`name contains 'quinn\'s paper\\essay'`). Useful clauses:
| Intent | q |
|---|---|
| children of a folder | `'FOLDER_ID' in parents` |
| only folders | `mimeType = 'application/vnd.google-apps.folder'` |
| exclude folders | `mimeType != 'application/vnd.google-apps.folder'` |
| name match | `name = 'exact'` / `name contains 'part'` |
| full text | `fullText contains 'invoice'` |
| owned by me | `'me' in owners` |
| shared with me | `sharedWithMe` |
| starred / not trashed | `starred = true and trashed = false` |
| modified since | `modifiedTime > '2026-01-01T00:00:00'` (RFC 3339) |

### 2.9 Shortcuts
A shortcut is a file with `mimeType = "application/vnd.google-apps.shortcut"` pointing at a target via
`shortcutDetails.targetId`. Create with `files.create`:
```jsonc
POST /files
{ "name": "SHORTCUT_NAME",
  "mimeType": "application/vnd.google-apps.shortcut",
  "shortcutDetails": { "targetId": "TARGET_FILE_OR_FOLDER_ID" },
  "parents": ["FOLDER_ID"] }        // optional placement
```
`shortcutDetails.targetMimeType` is **output-only** (auto-filled). The shortcut's ACL inherits its
parent's ACL. Shortcuts are how you make one file appear in multiple folders (multi-parenting is gone).

### 2.10 generateIds (idempotent creates)
`GET /files/generateIds?count=N&space=drive&type=files`. `count` default 10 (max 1000), `space`
default `drive` (or `appDataFolder`), `type` default `files` (or `shortcuts`, drive space only).
Returns `{ ids[], space, kind:"drive#generatedIds" }`. Pre-generate an ID and pass it as `id` in the
create body so a retried upload after a network failure reuses the same ID instead of duplicating.

---

## 3. Upload — three types (the tricky part)

Base upload URL: `https://www.googleapis.com/upload/drive/v3/files`; **`uploadType` is required.**
Create = `POST`; replace bytes on an existing file = `PATCH .../files/{fileId}`.

| Type | `uploadType` | Max size (guide) | Metadata? | Requests | Use for |
|---|---|---|---|---|---|
| Simple | `media` | 5 MB | none | 1 | tiny blob, no metadata |
| **Multipart** | `multipart` | 5 MB | yes (1 call) | 1 | **small file + metadata — best default for an MCP** |
| Resumable | `resumable` | large / unlimited | optional | 2+ | >5 MB or flaky network |

### 3.1 Simple (`uploadType=media`)
`POST /upload/drive/v3/files?uploadType=media`. Headers: `Content-Type: <mime>`, `Content-Length: <n>`.
Body = **raw bytes only** (no name/parents). You usually then `PATCH` metadata separately — which is why
multipart is preferred.

### 3.2 Multipart (`uploadType=multipart`) — EXACT wire shape
A JSON-only HTTP helper CANNOT build this; the client needs a **raw `fetch` with a hand-built
`multipart/related` body**. Metadata part comes FIRST, media part second.
```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: multipart/related; boundary=BOUNDARY_STRING
Content-Length: <total bytes>

--BOUNDARY_STRING
Content-Type: application/json; charset=UTF-8

{"name":"photo.jpg","parents":["FOLDER_ID"]}
--BOUNDARY_STRING
Content-Type: image/jpeg

<raw binary bytes of the file>
--BOUNDARY_STRING--
```
Rules: each boundary line is `--` + boundary; the terminating line is `--` + boundary + `--`. Part 1 is
`application/json; charset=UTF-8` with the File-resource metadata; part 2 is the media with its real
MIME type. Response = File JSON (request `?fields=id,name,webViewLink` to shape it). Build the body as a
`Buffer` (concat text + bytes + text) so binary is not corrupted by string encoding.

### 3.3 Resumable (`uploadType=resumable`) — for large/unreliable
Two steps:
1. **Initiate:** `POST /upload/drive/v3/files?uploadType=resumable` with headers
   `X-Upload-Content-Type: <mime>`, `X-Upload-Content-Length: <bytes>`, and (if sending metadata)
   `Content-Type: application/json; charset=UTF-8` + a JSON metadata body. Response returns the
   **session URI in the `Location` response header** (valid ~1 week).
2. **Upload:** `PUT <session URI>` with the bytes. Single-shot: `Content-Length: <size>`, full body.
   Chunked: repeat `PUT` with `Content-Range: bytes START-END/TOTAL` (chunks must be multiples of
   **256 KB** except the last). `308 Resume Incomplete` -> continue (check `Range` header for received
   bytes); `200/201` -> done; `404` -> session expired, restart.
   To probe/resume: `PUT` with `Content-Range: */TOTAL` and empty body.

---

## 4. Download / Export (binary, not JSON)

| Need | Call | Returns |
|---|---|---|
| Blob file bytes (PDF, image, zip, uploaded doc) | `GET /files/{fileId}?alt=media` | **raw bytes** |
| Partial blob | add header `Range: bytes=START-END` | byte range |
| Google-native doc (Docs/Sheets/Slides/Drawings) | `GET /files/{fileId}/export?mimeType=<target>` | **exported bytes** |

- **`alt=media` returns the file content in the response body** (binary), NOT metadata JSON. Only works
  for **blob** files stored in Drive. Add `acknowledgeAbuse=true` only after warning the user, for files
  Drive flagged as abusive.
- **Native Google docs cannot be fetched with `alt=media`** — you must `files.export`. `mimeType` is
  **required**. Exported content is limited to **10 MB**. Partial (`Range`) downloads are **not**
  supported while exporting.
- `webContentLink` (from `files.get?fields=webContentLink`) is a browser download link for blobs;
  `webViewLink` opens in the Drive UI.

**Export MIME types (ref-export-formats):**
| Source | Target -> MIME type |
|---|---|
| Docs | PDF `application/pdf` · DOCX `application/vnd.openxmlformats-officedocument.wordprocessingml.document` · TXT `text/plain` · HTML `text/html` · ODT `application/vnd.oasis.opendocument.text` · RTF `application/rtf` · EPUB `application/epub+zip` · Markdown `text/markdown` |
| Sheets | XLSX `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` · CSV `text/csv` (first sheet) · TSV `text/tab-separated-values` · PDF `application/pdf` · ODS `application/vnd.oasis.opendocument.spreadsheet` |
| Slides | PPTX `application/vnd.openxmlformats-officedocument.presentationml.presentation` · PDF `application/pdf` · TXT `text/plain` |
| Drawings | PNG `image/png` · JPEG `image/jpeg` · SVG `image/svg+xml` · PDF `application/pdf` |

**MCP note:** binary responses don't fit a JSON tool result. Return a saved local file path (write bytes
to disk) or a base64 field with a size cap; don't try to inline large binaries as text (§11).

---

## 5. Permissions / Sharing (sensitive)

| Method | Verb + Path | Key params / body | Response |
|---|---|---|---|
| **create** (share) | `POST /files/{fileId}/permissions` | query `sendNotificationEmail`,`emailMessage`,`transferOwnership`,`moveToNewOwnersRoot`,`useDomainAdminAccess`,`supportsAllDrives`; body = Permission | Permission |
| **list** | `GET /files/{fileId}/permissions` | query `pageSize`,`pageToken`,`fields`,`supportsAllDrives`,`useDomainAdminAccess` | `{permissions[], nextPageToken, kind}` |
| **get** | `GET /files/{fileId}/permissions/{permissionId}` | query `fields`,`supportsAllDrives` | Permission |
| **update** | `PATCH /files/{fileId}/permissions/{permissionId}` | query `removeExpiration`,`transferOwnership`,`useDomainAdminAccess`,`supportsAllDrives`; body `{role, expirationTime}` | Permission |
| **delete** (unshare) | `DELETE /files/{fileId}/permissions/{permissionId}` | query `supportsAllDrives`,`useDomainAdminAccess` | empty `{}` |

**Permission resource body:**
- `role`: `owner` · `organizer` · `fileOrganizer` · `writer` · `commenter` · `reader`.
- `type`: `user` · `group` · `domain` · `anyone`.
- `emailAddress` (for `user`/`group`), `domain` (for `domain`), `allowFileDiscovery` (bool; for
  `domain`/`anyone` — `true` = discoverable/searchable link, `false` = anyone-with-the-link only),
  `expirationTime` (RFC 3339), `view` (only `published`), `pendingOwner` (output for pending transfers).
- **list/get need explicit fields**: `fields=permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,expirationTime)`.
- `sendNotificationEmail` (default true for user/group) + `emailMessage` control the share email.
- **Only the last of concurrent permission ops on the same file is applied** — don't parallelize
  permission writes on one file.

**Ownership transfer caveat:** to make someone the owner you set `role: "owner"` (My Drive) and pass
**`transferOwnership=true`** as an acknowledgment; the current owner is downgraded to `writer`. For
consumer (gmail.com) accounts this requires the recipient to accept and is subject to Google's
restrictions; on Workspace it's typically same-domain only. Shared-drive ownership uses `organizer`, not
`owner`. Treat every ownership transfer as high-risk and confirm-gated (§9).

---

## 6. Revisions (brief)

| Method | Verb + Path | Notes |
|---|---|---|
| list | `GET /files/{fileId}/revisions` | `pageSize`,`pageToken`,`fields`; resp `{revisions[], nextPageToken, kind}`. May be incomplete for heavily-edited native docs. |
| get | `GET /files/{fileId}/revisions/{revisionId}` | add `alt=media` to **download that revision's bytes** (blob files). |
| update | `PATCH /files/{fileId}/revisions/{revisionId}` | body `{keepForever, published, publishAuto, publishedOutsideDomain}`. |
| delete | `DELETE /files/{fileId}/revisions/{revisionId}` | permanently deletes a version; **only for binary/blob files, not native Docs/Sheets/Slides**. |

`keepForever` pins a revision so it isn't auto-pruned (Drive keeps ~200 revisions / 30 days otherwise).
`published` (with `publishAuto`, `publishedOutsideDomain`) publishes a native-doc revision to the web.

---

## 7. OAuth scopes (exact strings) — and which one you actually need

| Scope | Grants | Class |
|---|---|---|
| `https://www.googleapis.com/auth/drive` | See, edit, create, delete **ALL** the user's Drive files | **Restricted** |
| `https://www.googleapis.com/auth/drive.readonly` | View + download all files | Restricted |
| `https://www.googleapis.com/auth/drive.metadata` | View + manage file **metadata** (no content, no create/upload/delete of content) | Restricted |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | Read metadata only | Restricted |
| `https://www.googleapis.com/auth/drive.file` | Create files, and access **only files the app created or the user opened via Picker** | Sensitive (non-restricted) |
| `https://www.googleapis.com/auth/drive.appdata` (`drive.appfolder`) | The app's hidden per-app config folder | Non-sensitive |
| `https://www.googleapis.com/auth/drive.install` | App appears in "Open with"/"New" | Non-sensitive |
| `https://www.googleapis.com/auth/drive.scripts` | Modify Apps Script behavior | Restricted |
| `https://www.googleapis.com/auth/drive.activity[.readonly]` | Drive Activity record | Restricted |
| `https://www.googleapis.com/auth/drive.apps.readonly` | View apps authorized on Drive | Sensitive |
| `https://www.googleapis.com/auth/drive.meet.readonly` | Meet-created Drive files (read) | Restricted |

**Which scope to MOVE / RENAME / DELETE / SHARE an EXISTING user file the app did NOT create?**
-> **The full `https://www.googleapis.com/auth/drive` scope. Nothing narrower works.**

**The `drive.file` trap:** `drive.file` is per-file and limited to files **your app created or the user
explicitly opened through the Google Picker**. It **cannot** touch, organize, share, or delete arbitrary
existing files in the user's Drive. So for a general "Drive manager" that reorganizes/shares files the
user already has, `drive.file` is a dead end — you must request restricted `drive`, which triggers
Google's OAuth verification + CASA security assessment for any published/external app.

---

## 8. Quotas / rate limits (2026 model)

As of **May 1, 2026**, Drive moved to a **quota-units model** ("an abstract unit of measurement
representing Google Drive resource usage"), replacing the old flat request counts. Existing projects
that called the API Nov 2025–Apr 2026 keep prior quotas during a transition; new projects use the new
limits; paid pricing beyond thresholds begins later in 2026. (Source: usage-limits page.)

| Limit | Value |
|---|---|
| Per project, per minute | 1,000,000 quota units |
| Per user per project, per minute | 325,000 quota units |
| Data egress per project, per day | 1 TB |
| Free daily allotment before billing | 400,000,000 quota units / project / day |

Approx per-call unit cost: read/get ~5, list ~100, download ~200, edit/update ~50, other (e.g.
generateIds) ~5. Errors on exceed: **HTTP 403 "User Rate Limit Exceeded"** / **HTTP 429 "Rate Limit
Exceeded"** (reasons `userRateLimitExceeded`, `rateLimitExceeded`; also `dailyLimitExceeded`,
`sharingRateLimitExceeded` for share bursts). Mitigate with **truncated exponential backoff**:
`min((2^n)+random_ms, max_backoff)`, `max_backoff` ~32–64s. The repo's `http.ts` already retries 429
three times — extend it to honor `Retry-After` and to back off on 403 `userRateLimitExceeded`.
Sharing operations have their own tighter burst limit (`sharingRateLimitExceeded`) — throttle bulk
`permissions.create`.

---

## 9. Safety notes — what MUST be confirm-gated

| Operation | Why dangerous | Reversible | Gate |
|---|---|---|---|
| `files.delete` | permanent, bypasses Trash; folder deletes all descendants | **No** | hard confirm; prefer trashing instead |
| `files.emptyTrash` | wipes ALL trashed files at once | **No** | hard confirm + count preview |
| `revisions.delete` | destroys a file version | **No** | confirm |
| `permissions.create type:anyone` | public / anyone-with-link exposure of user data | reversible but leaks meanwhile | confirm + surface `allowFileDiscovery` |
| `permissions.create/update transferOwnership` | user loses ownership (downgraded to writer) | hard to reverse | strong confirm |
| bulk `permissions.*` / bulk move / bulk trash | blast radius + `sharingRateLimitExceeded` | varies | `dry_run:true` default |

Follow the repo convention: destructive tools take `confirm: boolean = false`, build a `preview` string
with the real action+scope (never fabricated values), and call `guardDestructive(...)` before any side
effect. For batch ops use `dry_run: boolean = true` so the safe default returns the candidate list.
Default any user-facing "delete" to **trashing** (`trashed:true`), not `files.delete`.

---

## 10. Recommended tool set (write / organize / share / media) — ~24 tools

Snake_case, `drive_` prefix (matches existing `drive_scan`/`drive_search`), descriptions ≤15 tokens.
All API-backed tools depend on the new OAuth+`drive`-scope client from §0.

**Folders & create (3)**
1. `drive_create_folder` — `files.create` folder; params name, parent_id.
2. `drive_create_shortcut` — `files.create` shortcut to a target_id; params name, target_id, parent_id.
3. `drive_generate_ids` — `files.generateIds` for idempotent uploads (optional/internal).

**Organize (5)**
4. `drive_rename` — `files.update {name}`.
5. `drive_move` — `files.update?addParents&removeParents` (auto-reads current parent).
6. `drive_star` — `files.update {starred}` (bool toggle).
7. `drive_copy` — `files.copy` (name+parents; file-only, reject folders with guidance).
8. `drive_update_metadata` — `files.update {description, mimeType, appProperties}`.

**Trash / delete (destructive) (4)**
9. `drive_trash` — `files.update {trashed:true}` (safe default "delete").
10. `drive_restore` — `files.update {trashed:false}`.
11. `drive_delete` — `files.delete` PERMANENT (confirm-gated).
12. `drive_empty_trash` — `files.emptyTrash` (confirm-gated + preview count).

**API-native read/resolve (needed because local index IDs != API fileIds) (2)**
13. `drive_api_list` — `files.list` with `q`/folder/`orderBy`/pagination + rich `fields`.
14. `drive_get` — `files.get` with explicit `fields` (parents, owners, links, size).

**Upload / download / export (media) (4)**
15. `drive_upload` — multipart create (raw fetch; falls back to resumable if >5 MB); params local_path, name, parent_id, mime_type.
16. `drive_update_content` — `PATCH /upload/.../{fileId}` replace bytes of an existing file.
17. `drive_download` — `files.get?alt=media` -> write to local path; params file_id, dest_path.
18. `drive_export` — `files.export?mimeType=` for native docs -> local path (10 MB cap warning).

**Sharing (sensitive) (4)**
19. `drive_share` — `permissions.create` (role/type/email; sendNotificationEmail; confirm on type:anyone).
20. `drive_list_permissions` — `permissions.list` with explicit fields.
21. `drive_update_permission` — `permissions.update` (role/expiration/removeExpiration).
22. `drive_unshare` — `permissions.delete`.

**Revisions + ownership (optional, 2)**
23. `drive_list_revisions` / `drive_keep_revision` — `revisions.list` + `revisions.update {keepForever}`.
24. `drive_transfer_ownership` — `permissions.create/update transferOwnership=true` (strong confirm; separate from `drive_share` so it can't be triggered accidentally).

---

## 11. Blunt implementation flags

1. **Multipart upload needs a raw multipart `fetch`, not the JSON `fetchJson` helper.** You must
   hand-assemble a `multipart/related` body (boundary, `application/json` metadata part first, then the
   media part) as a `Buffer` and send it with `Content-Type: multipart/related; boundary=...`. Plan a
   separate upload path in the client (and a resumable fallback for >5 MB). This is real work, not a
   param tweak.
2. **Download and export return BINARY, not JSON.** `files.get?alt=media` and `files.export` respond
   with bytes. The existing client assumes JSON; you need a bytes path (`response.arrayBuffer()`), and
   the MCP tool must return a **saved local file path** (or capped base64), never inline the binary as a
   tool text result.
3. **Scope: organizing/sharing/deleting EXISTING user files requires the full
   `https://www.googleapis.com/auth/drive` scope.** `drive.file` only reaches app-created/Picker-opened
   files and is useless for a general Drive manager. Full `drive` is a *restricted* scope -> Google
   verification + CASA assessment for any non-internal app.
4. **(Bigger than all three)** The current read side is a **local FS scanner with synthetic
   `rootId:relpath` IDs and no OAuth** (§0). The entire write side is a new API integration with its own
   OAuth token and real Drive `fileId`s; the two do not share identity. Budget for a new auth bootstrap
   and an ID-resolution story before any write tool is usable.
