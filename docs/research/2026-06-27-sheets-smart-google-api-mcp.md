# Research: sheets-smart — Google Sheets/Drive API + MCP SDK build reference

**Generated:** 2026-06-27
**Methodology:** Rule-of-5 deep research, 4 parallel agents (MCP SDK, Sheets API v4, Drive API v3 + OAuth, existing smart-mcps conventions)
**Sources:** official `developers.google.com/workspace/sheets`, `developers.google.com/drive`, `developers.google.com/identity`, npm registry, installed `@modelcontextprotocol/sdk` type defs, context7 official MCP docs, live smart-mcps source.
**Purpose:** Verified facts to build `packages/sheets-smart` without guessing from training data. This is the build reference for the spec + plan.

## Executive summary

Adding `sheets-smart` is a low-risk mirror of `calendar-smart`. The MCP SDK (1.29.0, installed = latest) and the Google REST surfaces are all verified below. The one real gotcha is OAuth: an "external + Testing" consent screen issues **7-day** refresh tokens for Drive/Sheets scopes — must confirm the project is in **Production** first. Scope decision (per Santo): full `spreadsheets` + `drive`.

---

## Part 1 — MCP TypeScript SDK (`@modelcontextprotocol/sdk`)

- **Version:** latest stable `1.29.0` (npm `latest`, published 2026-03-30); **installed in repo = 1.29.0** (pinned `^1.12.0`). A `2.0.0-alpha` exists — do NOT target it.
- **House pattern (use this):** the suite does NOT call `McpServer.registerTool` directly. `core/src/server.ts` exports `createMcpServer({ name, version, tools, context })` (low-level `Server` + `setRequestHandler(ListTools/CallTool)` + `zodToJsonSchema`) and `defineTool({ name, description, inputSchema, handler })`. New package imports both from `smart-mcp-core`. `core/src/server.ts:17-23, 58-91`.
- **Input schemas:** zod `z.object({...})`; the registry parses input via `tool.inputSchema.parse(rawInput)` before dispatch. SDK 1.29 peer-deps `zod ^3.25 || ^4.0`.
- **Result shape:** handlers return a plain serializable object; `createMcpServer` wraps it as `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`. No `outputSchema`/`structuredContent` in current house style (supported by SDK but unused).
- **Errors:** handlers throw typed `SmartMcpError` subclasses; central `toMcpResult` converts to `{ isError: true, content: [...] }`. `core/src/errors.ts`, `core/src/server.ts:25-49`.
- **Transport:** `StdioServerTransport` + `server.connect` (inside `createMcpServer`). Log to stderr only.
- **Forward note:** SDK v2 will require Standard Schema input and drop deprecated `.tool()`; the house `createMcpServer`/`defineTool` wrapper isolates us from that churn.

Citations: installed `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts`; npm registry `time`/`dist-tags`; context7 `/modelcontextprotocol/typescript-sdk`; `packages/core/src/{server,errors}.ts`.

---

## Part 2 — Google Sheets API v4 (verified host: `https://sheets.googleapis.com/v4`)

All bodies `application/json`; `:append`/`:clear`/`:batchUpdate` are literal colon verbs.

| Op | Method + URL | Key facts |
|---|---|---|
| create | `POST /spreadsheets` | Body = full `Spreadsheet`. Can seed cells via `sheets[].data[].rowData[].values[].userEnteredValue` (`stringValue`/`numberValue`/`boolValue`/`formulaValue`) + `userEnteredFormat`. Response: `spreadsheetId`, `spreadsheetUrl`, `sheets[].properties.sheetId`. Omitted `sheetId` is auto-assigned — read it back. **No parent-folder param** (lands in Drive root; use Drive to place in a folder). |
| get | `GET /spreadsheets/{id}` | Params `ranges`, `includeGridData`, `fields` mask. Returns `sheets[].properties` (sheetId/title/index/gridProperties incl. `frozenRowCount`), `namedRanges`. Use a `fields` mask for cheap metadata. |
| values.get | `GET /spreadsheets/{id}/values/{range}` | `majorDimension` ROWS/COLUMNS; `valueRenderOption` FORMATTED_VALUE(default)/UNFORMATTED_VALUE/FORMULA; `dateTimeRenderOption`. Empty trailing cells omitted. |
| values.update | `PUT /spreadsheets/{id}/values/{range}?valueInputOption=` | **Required** `valueInputOption`: `USER_ENTERED` (parses formulas/dates/currency like a human typed) vs `RAW` (verbatim text). **Use USER_ENTERED for formulas.** Body `ValueRange`. |
| values.append | `POST /spreadsheets/{id}/values/{range}:append?valueInputOption=&insertDataOption=` | `{range}` is only a **table search hint**, not the write location — append writes after the detected table. `insertDataOption=INSERT_ROWS` to shift existing content instead of `OVERWRITE`. Response: `updates.updatedRange`. |
| values.clear | `POST /spreadsheets/{id}/values/{range}:clear` | Empty body. Clears values only; keeps formatting/validation. |
| values.batchUpdate | `POST /spreadsheets/{id}/values:batchUpdate` | Multiple ranges, one quota unit. `valueInputOption` in body. |
| **batchUpdate (structural)** | `POST /spreadsheets/{id}:batchUpdate` | `{ requests: [...] }`, applied **in order, atomically** (any invalid → whole call fails). **0-based half-open** indices, target by `sheetId`. |

**Structural request types** (all in the batchUpdate endpoint): `addSheet`, `deleteSheet`, `updateSheetProperties` (rename + `gridProperties.frozenRowCount`), `repeatCell` (one format over a range — bold header, currency column via `numberFormat{type,pattern}`), `updateCells` (explicit per-cell values+formats), `updateDimensionProperties` (`pixelSize` width/height), `autoResizeDimensions`, `mergeCells`/`unmergeCells`, `updateBorders`, `sortRange`, `addNamedRange`. **Future-extension hooks (same endpoint):** `addConditionalFormatRule`, `addChart`, `setDataValidation`, `addBanding`, `addProtectedRange`, `addFilterView`. `NumberFormat.type`: TEXT/NUMBER/PERCENT/CURRENCY/DATE/TIME/DATE_TIME/SCIENTIFIC.

**A1 notation:** `Sheet1!A1`, `Sheet1!A1:B2`, whole col `Sheet1!A:A`, whole row `Sheet1!1:1`, unbounded `Sheet1!A5:A`, whole tab `Sheet1`, named range = bare name. Quote titles with spaces/specials in single quotes: `'My Sheet'!A:A`. (Apostrophe-in-title escaping UNVERIFIED — test before relying.)

**Quotas:** 300/min/project and **60/min/user** for both reads and writes; no daily cap. A batch call = 1 unit. On `429 RESOURCE_EXHAUSTED` use truncated exponential backoff + jitter (`min(2^n + rand_ms, max_backoff)`).

Citations: `developers.google.com/workspace/sheets/api/reference/rest/v4/...` (create, get, values.{get,update,append,clear,batchUpdate}, spreadsheets/batchUpdate, /request), `/guides/concepts`, `/api/limits`.

---

## Part 3 — Google Drive API v3 (host: `https://www.googleapis.com/drive/v3`)

| Op | Method + URL | Key facts |
|---|---|---|
| list | `GET /files` | `q` search; for Sheets only: `q=mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`; add `name contains 'x'`. `'`→`\'`, `\`→`\\` escaping in `q`. `pageSize` max 100. Always request `fields=nextPageToken,files(id,name,modifiedTime,webViewLink)`. `orderBy=modifiedTime desc`. |
| create | `POST /files` | Body `{name, mimeType:"application/vnd.google-apps.spreadsheet", parents:[folderId]}` — this is how you create a sheet **inside a folder** (Sheets create can't). |
| update | `PATCH /files/{id}` | Patch semantics. **Rename:** `name` in body. **Move:** `addParents`/`removeParents` in **query** (not body). Can do both at once. |
| delete | `DELETE /files/{id}` | Permanent, no trash, not recoverable. **Prefer trashing.** |
| trash | `PATCH /files/{id}` body `{"trashed":true}` | Recoverable 30 days. Restore with `false`. **Default destructive op for the MCP.** |
| share | `POST /files/{id}/permissions` | Body `{role: reader/commenter/writer/owner, type: user/group/domain/anyone, emailAddress}`. Query `sendNotificationEmail`. "Anyone with link" reader: `{type:"anyone", role:"reader"}`. |
| link | `GET /files/{id}?fields=webViewLink` | Shareable link comes from `webViewLink`, not the permissions response. |

Sheet mimeType `application/vnd.google-apps.spreadsheet`; folder `application/vnd.google-apps.folder`. Export to xlsx/csv/pdf via `/files/{id}/export?mimeType=`.

**Drive quotas:** ~1M units/min/project, 325k/user/min; `files.list`=100 units, `files.get`=5, `files.update`=50. Handle `403 userRateLimitExceeded`/`429` with backoff+jitter; do NOT retry `insufficientPermissions`.

Citations: `developers.google.com/drive/api/reference/rest/v3/{files.list,files.create,files.update,files.delete,permissions.create}`, `/guides/{search-files,delete,manage-sharing,mime-types,limits}`.

---

## Part 4 — OAuth 2.0 (the part that needs care)

**Scope strings (Santo chose full access):**
- `https://www.googleapis.com/auth/spreadsheets` (full Sheets, "sensitive")
- `https://www.googleapis.com/auth/drive` (full Drive, "restricted")
- (least-privilege alt, not chosen: `drive.file` = only app-created files, avoids restricted-scope verification.)

**Installed-app flow (2026, verified):**
- Auth endpoint `https://accounts.google.com/o/oauth2/v2/auth`; token endpoint `https://oauth2.googleapis.com/token`.
- **Loopback alive & recommended** for Desktop clients: `http://127.0.0.1:<port>` / `http://[::1]:<port>` (localhost works but may hit client firewalls). **OOB is dead.** Custom URI schemes unsupported.
- **Port is ignored** for Desktop-client loopback matching — bind an ephemeral port at runtime, pass that exact `redirect_uri`. (This is exactly what the existing `calendar-smart-auth.ts` does — binds `127.0.0.1:0`.)
- **PKCE** (`code_challenge`+`S256`, `code_verifier` at exchange) is recommended-not-required for desktop. Existing house auth bin does NOT use PKCE; mirror it, treat PKCE as optional hardening.
- Refresh token: include `access_type=offline` + `prompt=consent`. Refresh token returned on first consent (or forced by `prompt=consent`).

**>>> CRITICAL: the 7-day Testing trap <<<**
An OAuth consent screen with **external** user type AND **publishing status = "Testing"** issues refresh tokens that **expire in 7 days** whenever non-basic scopes (anything beyond name/email/profile) are requested. Since sheets-smart requests Drive/Sheets, a Testing-mode project's token dies after 7 days.
- **Fix:** consent screen must be **Production** (or Internal, Workspace-only).
- **Inference:** calendar-smart/email-smart already use sensitive scopes (`calendar`, `gmail.modify`) and persist across sessions → project is very likely already **Production**. **Pre-flight: confirm before building** so we don't ship a tool that breaks weekly.

Token file shape written by the auth bin (matches core `AuthorizedUserFile`): `{ token, refresh_token, token_uri, client_id, client_secret, scopes, expiry }` at mode 0600.

Citations: `developers.google.com/identity/protocols/oauth2/{scopes,native-app,web-server}`, `/oauth2` overview, `support.google.com/cloud/answer/15549945`.

---

## Part 5 — How sheets-smart mirrors calendar-smart (conventions)

- **Package:** `packages/sheets-smart`, `name: "sheets-smart"`, `private`, `type: module`, `main: dist/server.js`, bins `sheets-smart` + `sheets-smart-auth`. Deps `smart-mcp-core`, `@modelcontextprotocol/sdk ^1.12.0`, `zod`. Dev: typescript, vitest, msw, @types/node. `tsconfig` extends base, references `../core`.
- **Files:** `src/server.ts` (createMcpServer bootstrap, shebang), `src/context.ts` (loadCreds, `SHEETS_DEFAULT_IDENTITY` env → default `"your-account"`), `src/client.ts` (REST client, `fetchJson`, error mapping, `GoogleOAuthClient` with `fileSuffix:".sheets.json"`), `src/bin/sheets-smart-auth.ts` (loopback consent → `<account>.sheets.json`), `src/tools/*.ts` + `src/tools/index.ts` (registry), `src/*-mapper.ts`, `src/null-helpers.ts`.
- **Constants:** `SHEETS_API_BASE = "https://sheets.googleapis.com/v4"`, `DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"`, `SHEETS_TOKEN_FILE_SUFFIX = ".sheets.json"`, `SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"]`.
- **Core API consumed:** `createMcpServer`, `defineTool`, `GoogleOAuthClient(account,{home,fileSuffix,reauthHint,requiredScope})` with `getAccessToken()`/`hasScope()`, `fetchJson(url,{token,...})` (maps 400→Validation, 401/403→Auth, 404→NotFound, 429→RateLimit, 5xx→Upstream), `loadCreds({serviceName,required,optional})`, `guardDestructive({confirm,preview})`.
- **Style:** kebab-case files, snake_case tool names + fields, short tool descriptions, `reauthHintFor(account)` → `node packages/sheets-smart/dist/bin/sheets-smart-auth.js <account>`.
- **Tests:** vitest + msw, colocated `__tests__/`; auth test injects `codeReader`/`now` seams; tool tests use fake clients + assert metadata/handler.
- **Register:** `scripts/install-clients.sh sheets-smart` writes `~/.claude.json` `mcpServers.sheets-smart = { command:"node", args:[".../dist/server.js"] }`.

---

## Recommendations / decisions settled

1. Mirror calendar-smart exactly via `createMcpServer`/`defineTool`; do not adopt `McpServer.registerTool`.
2. Scope = `spreadsheets` + `drive` (Santo: full access). Token suffix `.sheets.json`.
3. Verified hosts: `sheets.googleapis.com/v4` (Sheets), `www.googleapis.com/drive/v3` (Drive).
4. Writes use `USER_ENTERED` by default (expose `value_input_option` to allow RAW). Append defaults `INSERT_ROWS`.
5. Destructive tools (`delete_sheet`, `share_sheet`) gated by `guardDestructive`; default to **trash**, not hard-delete.
6. One generic `batch_update` plumbing path for structural/format requests so conditional-formatting / charts / data-validation bolt on later without new transport code.

## Warnings

- **Confirm consent screen is in Production** (else 7-day refresh-token death) — pre-flight gate.
- Sheets `create` cannot set a parent folder; use Drive `files.create` or `files.update` addParents to place/move.
- batchUpdate indices are 0-based half-open and target `sheetId` (int), not tab title — fetch sheetId via `get` first.
- 60 writes/min/user ceiling — batch aggressively.

## Open questions (for pre-flight, not blockers)

- OAuth consent screen publishing status = Production? (verify in GCP console for the project behind `client.json`.)
- Is Google Sheets API enabled on that GCP project? (Drive API already is, since drive scopes work elsewhere; Sheets API may need enabling.)
- Apostrophe-in-tab-name A1 escaping (test if it ever matters).

## All sources
MCP SDK: npm registry; installed `mcp.d.ts`; context7 `/modelcontextprotocol/typescript-sdk`.
Sheets: `developers.google.com/workspace/sheets/api/reference/rest/v4/*`, `/guides/concepts`, `/api/limits`.
Drive: `developers.google.com/drive/api/reference/rest/v3/*`, `/guides/{search-files,delete,manage-sharing,mime-types,ref-export-formats,limits}`.
OAuth: `developers.google.com/identity/protocols/oauth2/{scopes,native-app,web-server}`, `/oauth2`, `support.google.com/cloud/answer/15549945`.
Conventions: live source under `packages/{core,calendar-smart}/`.
