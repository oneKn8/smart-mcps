# sheets-smart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent `sheets-smart` MCP server giving full read/write control of Google Sheets in Santo's personal Google account (16 tools), proven by creating a real ledger sheet end-to-end.

**Architecture:** Mirror `packages/calendar-smart` exactly. Low-level via core's `createMcpServer`/`defineTool`. Raw REST to Sheets v4 + Drive v3 using a `.sheets.json` OAuth token (scopes `spreadsheets`+`drive`) minted by a cloned loopback auth bin. One `SheetsClient` wraps both APIs; tools are thin handlers over it.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk ^1.12.0` (installed 1.29.0), `zod`, `smart-mcp-core`, vitest + msw.

**Backing research:** `docs/research/2026-06-27-sheets-smart-google-api-mcp.md` (all API shapes verified). **Design:** `docs/2026-06-27-phase-6-sheets-smart-design.md`.

## Global Constraints

- Package name `sheets-smart`; `private: true`; `type: "module"`; `main: dist/server.js`; bins `sheets-smart` → `dist/server.js`, `sheets-smart-auth` → `dist/bin/sheets-smart-auth.js`.
- Deps: `smart-mcp-core: "*"`, `@modelcontextprotocol/sdk: "^1.12.0"`, `zod: "^3.24.0"`. Dev: `typescript ^5.7`, `vitest ^2.1`, `msw ^2.6`, `@types/node ^22`.
- `SHEETS_API_BASE="https://sheets.googleapis.com/v4"`, `DRIVE_API_BASE="https://www.googleapis.com/drive/v3"`, `SHEETS_TOKEN_FILE_SUFFIX=".sheets.json"`, `SHEETS_SCOPES=["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"]`.
- Default identity: env `SHEETS_DEFAULT_IDENTITY` else `"your-account"`.
- Files kebab-case; tool names + JSON fields snake_case; tool descriptions short.
- Writes default `valueInputOption=USER_ENTERED`; append defaults `insertDataOption=INSERT_ROWS`.
- Destructive tools (`delete_sheet`, `delete_tab`, `share_sheet`) require `confirm:true` via `guardDestructive`; `delete_sheet` defaults to trash.
- No live Google calls in tests (msw-mocked). `HOME` overridden per test.
- Conventional Commits. Commit per task.

---

## Phase 0 — Scaffold

### Task 0: Package skeleton that builds empty

**Files:**
- Create: `packages/sheets-smart/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create dirs: `src/`, `src/bin/`, `src/tools/`, `src/__tests__/`, `src/tools/__tests__/`, `src/bin/__tests__/`

**Interfaces — Produces:** a workspace package the root build discovers.

- [ ] Copy `packages/calendar-smart/{package.json,tsconfig.json,vitest.config.ts}`; rename `calendar`→`sheets`, set version `0.1.0`, bins per Global Constraints, description "Smart MCP for Google Sheets (read + write), single-account, wraps ~/.santo-agent OAuth token jar."
- [ ] Create `src/server.ts` minimal stub: `#!/usr/bin/env node` importing `createMcpServer`, empty `tools` array, `buildContext()` (temporary throwaway) — just enough to compile.
- [ ] `npm install` at root (links workspace).
- [ ] Run `npm run build --workspace=sheets-smart` → expect clean tsc.
- [ ] Commit: `chore(sheets-smart): scaffold package`.

---

## Phase 1 — Auth bin

### Task 1: `sheets-smart-auth` token-mint CLI

**Files:**
- Create: `src/bin/sheets-smart-auth.ts` (clone of `packages/calendar-smart/src/bin/calendar-smart-auth.ts`)
- Test: `src/bin/__tests__/sheets-smart-auth.test.ts` (clone of calendar's auth test)

**Interfaces — Produces:** `runAuth({account, home, redirectUri, codeReader, now?, log?}) → {tokenPath, expiry}`; writes `~/.santo-agent/oauth/<account>.sheets.json` (0600) with `{token,refresh_token,token_uri,client_id,client_secret,scopes,expiry}`.

- [ ] Clone the calendar auth bin verbatim; change only: `TOKEN_FILE_SUFFIX = ".sheets.json"`; replace `CALENDAR_SCOPE` const with `SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"]` and join with a space in `buildAuthorizationUrl` (`scope=` param); loopback success page text → "sheets-smart authorized — return to terminal."
- [ ] Clone the auth test; change expected scopes to both Sheets+Drive, token filename to `<account>.sheets.json`, mocked token-exchange `scope` to the two scopes space-joined.
- [ ] Run `npm test --workspace=sheets-smart` → auth test PASS.
- [ ] Commit: `feat(sheets-smart): add loopback OAuth token-mint bin`.

---

## Phase 2 — Sheet-ref + client

### Task 2: `sheet-ref.ts` — parse ID/URL + A1 helpers (TDD)

**Files:**
- Create: `src/sheet-ref.ts`
- Test: `src/__tests__/sheet-ref.test.ts`

**Interfaces — Produces:**
- `parseSpreadsheetId(input: string): string` — accepts bare ID or `https://docs.google.com/spreadsheets/d/<ID>/edit...`; throws `ValidationError` on junk.
- `quoteSheetTitle(title: string): string` — single-quote-wrap when title has spaces/specials, doubling inner apostrophes.

- [ ] **Test first:** `parseSpreadsheetId("1AbC_xyz-123")` → `"1AbC_xyz-123"`; `parseSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC_xyz-123/edit#gid=0")` → `"1AbC_xyz-123"`; `parseSpreadsheetId("not a url")` throws `ValidationError`. `quoteSheetTitle("My Sheet")` → `"'My Sheet'"`; `quoteSheetTitle("Plain")` → `"Plain"`; `quoteSheetTitle("Jon's")` → `"'Jon''s'"`.
- [ ] Run → FAIL.
- [ ] Implement: regex `\/spreadsheets\/d\/([a-zA-Z0-9-_]+)`; bare-ID guard `^[a-zA-Z0-9-_]{20,}$` (Google IDs are long); else `throw new ValidationError("not a spreadsheet id or url: " + input)`. `quoteSheetTitle`: if `/[^A-Za-z0-9_]/.test(title)` → `"'" + title.replace(/'/g, "''") + "'"` else title.
- [ ] Run → PASS. Commit: `feat(sheets-smart): spreadsheet ref + A1 helpers`.

### Task 3: `SheetsClient` — Sheets v4 + Drive v3 REST (TDD)

**Files:**
- Create: `src/client.ts`, `src/mappers.ts`, `src/null-helpers.ts` (clone null-helpers from calendar)
- Test: `src/__tests__/client.test.ts` (msw-mocked, token-file fixture like calendar)

**Interfaces — Produces:** `class SheetsClient`, constructed `new SheetsClient(account, {home?, oauthClient?})`, with `getAccount()` and these async methods (all call `fetchJson` with `token = await this.oauth.getAccessToken()`):

```
// Sheets v4
createSpreadsheet(body): {spreadsheetId, spreadsheetUrl, sheets[]}        POST /spreadsheets
getSpreadsheet(id, {fields?, ranges?, includeGridData?}): Spreadsheet     GET  /spreadsheets/{id}
getValues(id, range, {valueRenderOption?, majorDimension?}): ValueRange   GET  /spreadsheets/{id}/values/{range}
updateValues(id, range, values, valueInputOption): UpdateValuesResponse   PUT  /spreadsheets/{id}/values/{range}?valueInputOption=
appendValues(id, range, values, valueInputOption, insertDataOption): AppendValuesResponse  POST .../values/{range}:append?...
batchUpdateValues(id, data[], valueInputOption): BatchUpdateValuesResponse POST /spreadsheets/{id}/values:batchUpdate
clearValues(id, range): ClearValuesResponse                               POST /spreadsheets/{id}/values/{range}:clear
batchUpdate(id, requests[]): BatchUpdateSpreadsheetResponse               POST /spreadsheets/{id}:batchUpdate
// Drive v3
listFiles(q, {pageSize?, pageToken?, orderBy?, fields?}): {files[], nextPageToken?}  GET /files
createFile(body): File                                                   POST /files
updateFile(id, body, {addParents?, removeParents?}): File                PATCH /files/{id}
trashFile(id): File                                                      PATCH /files/{id} {trashed:true}
deleteFile(id): void                                                     DELETE /files/{id}
createPermission(id, body, {sendNotificationEmail?}): Permission         POST /files/{id}/permissions
getWebViewLink(id): string                                               GET /files/{id}?fields=webViewLink
```

- URL-encode `{range}` with `encodeURIComponent`. Build query strings explicitly. Reuse `mapGoogleAuthError(err, account)` pattern from calendar (`401`→AuthError+reauth hint, `403`→AuthError, pass through Validation/NotFound).
- `reauthHintFor(account) = "node packages/sheets-smart/dist/bin/sheets-smart-auth.js " + account`.

- [ ] **Test first:** write token fixture `<account>.sheets.json`; msw-mock `POST https://sheets.googleapis.com/v4/spreadsheets` → `{spreadsheetId:"SID", spreadsheetUrl:"U", sheets:[{properties:{sheetId:0,title:"Ledger"}}]}`; assert `createSpreadsheet(...)` returns it and sent `Authorization: Bearer <token>`. Mock `GET .../values/Ledger!A1:B2` → values; assert `getValues` shapes correctly. Mock a 401 → assert `AuthError` mentions the reauth command.
- [ ] Run → FAIL. Implement client. Run → PASS.
- [ ] Commit: `feat(sheets-smart): Sheets+Drive REST client`.

---

## Phase 3 — Wire server

### Task 4: `context.ts` + real `server.ts`

**Files:**
- Create/replace: `src/context.ts`, `src/server.ts`
- Test: `src/__tests__/context.test.ts`

**Interfaces — Produces:** `type SheetsContext = { client: SheetsClient }`; `buildContext(home?) → SheetsContext` resolving `SHEETS_DEFAULT_IDENTITY` via `loadCreds({serviceName:"sheets-smart", required:[], optional:["SHEETS_DEFAULT_IDENTITY"]})` else `"your-account"`.

- [ ] Clone calendar `context.ts`; swap names; `DEFAULT_IDENTITY="your-account"`.
- [ ] `server.ts`: `await createMcpServer<SheetsContext>({ name:"sheets-smart", version:"0.1.0", tools, context: buildContext() })`.
- [ ] Test: `buildContext()` returns a `SheetsClient` whose `getAccount()` honors env override. Run → PASS. Commit: `feat(sheets-smart): context + server bootstrap`.

---

## Phase 4 — Tools (TDD per file)

Each tool uses `defineTool<Input, Output, SheetsContext>({ name, description, inputSchema: schema as unknown as z.ZodType<Input>, handler })`. Every spreadsheet input is `z.string()` named `spreadsheet`, resolved via `parseSpreadsheetId`. Each tool file gets a colocated `__tests__` asserting (a) `.name`/`.description`, (b) handler calls the right client method with mapped args (fake client via `vi.fn()`).

### Task 5: `tools/spreadsheets.ts` — `list_sheets`, `create_sheet`, `get_sheet`, `delete_sheet`

**Files:** Create `src/tools/spreadsheets.ts`; Test `src/tools/__tests__/spreadsheets.test.ts`.

Exact behavior:
- `list_sheets{query?, page_size?=100, page_token?}` → `client.listFiles(q, {...})` where `q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false" + (query ? " and name contains '" + escapeQ(query) + "'" : "")`, `fields="nextPageToken,files(id,name,modifiedTime,webViewLink)"`, `orderBy="modifiedTime desc"`. Output `{sheets: files.map(f=>({id,name,modified_time,url:webViewLink})), next_page_token}`. `escapeQ` doubles `\` then `'`.
- `create_sheet{title, folder_id?, tabs?:string[], seed?:{tab?,header?:string[],rows?:any[][]}}` → build Spreadsheet body (`properties.title`, `sheets` from `tabs`/seed via `userEnteredValue` cells, USER_ENTERED not applicable at create — values are literal `stringValue`/`numberValue`/`formulaValue`; detect leading `=` → `formulaValue`, number → `numberValue`, else `stringValue`). `client.createSpreadsheet(body)`; if `folder_id`, `client.updateFile(id, {}, {addParents: folder_id})`. Output `{spreadsheet_id, url, sheets:[{sheet_id,title}]}`.
- `get_sheet{spreadsheet}` → `client.getSpreadsheet(id, {fields:"spreadsheetId,spreadsheetUrl,properties.title,sheets.properties,namedRanges"})`; map to `{title,url,tabs:[{sheet_id,title,rows,cols,frozen_rows}],named_ranges}`.
- `delete_sheet{spreadsheet, permanent?=false, confirm?=false}` → `guardDestructive({confirm, preview:"Delete spreadsheet "+id+(permanent?" PERMANENTLY":" (to trash)")})`; `permanent ? client.deleteFile(id) : client.trashFile(id)`. Output `{trashed:!permanent, deleted:permanent, spreadsheet_id:id}`.

- [ ] Tests first (4 tools) → FAIL → implement → PASS → Commit `feat(sheets-smart): spreadsheet lifecycle tools`.

### Task 6: `tools/values.ts` — `read_range`, `write_range`, `append_rows`, `update_cells`, `clear_range`

**Files:** Create `src/tools/values.ts`; Test `src/tools/__tests__/values.test.ts`.

- `read_range{spreadsheet, range, value_render?="FORMATTED_VALUE", major_dimension?="ROWS"}` → `client.getValues` → `{range, values:values??[]}`.
- `write_range{spreadsheet, range, values, value_input_option?="USER_ENTERED"}` → `client.updateValues` → `{updated_range, updated_cells}`.
- `append_rows{spreadsheet, range, values, value_input_option?="USER_ENTERED", insert_option?="INSERT_ROWS"}` → `client.appendValues` → `{updated_range:updates.updatedRange, updated_rows:updates.updatedRows}`.
- `update_cells{spreadsheet, data:[{range,values}], value_input_option?="USER_ENTERED"}` → `client.batchUpdateValues` → `{total_updated_cells}`.
- `clear_range{spreadsheet, range}` → `client.clearValues` → `{cleared_range}`.

- [ ] Tests first → FAIL → implement → PASS → Commit `feat(sheets-smart): value read/write/append/clear tools`.

### Task 7: `tools/structure.ts` — `add_tab`, `rename_tab`, `delete_tab`, `format_range`, `batch_update`

**Files:** Create `src/tools/structure.ts`; Test `src/tools/__tests__/structure.test.ts`.

Internal helper `runBatch(client, id, requests)` → `client.batchUpdate(id, requests)`.
- `add_tab{spreadsheet, title, rows?=1000, cols?=26}` → `[{addSheet:{properties:{title,gridProperties:{rowCount:rows,columnCount:cols}}}}]`; return `{sheet_id: reply.addSheet.properties.sheetId, title}`.
- `rename_tab{spreadsheet, sheet_id, title}` → `[{updateSheetProperties:{properties:{sheetId:sheet_id,title},fields:"title"}}]`.
- `delete_tab{spreadsheet, sheet_id, confirm?=false}` → `guardDestructive`; `[{deleteSheet:{sheetId:sheet_id}}]`.
- `format_range{spreadsheet, sheet_id, start_row, end_row, start_col, end_col, bold?, number_format?, background?, freeze_rows?}` → compose `repeatCell` (textFormat.bold / numberFormat{type,pattern} / backgroundColor) over the `GridRange`, plus `updateSheetProperties` `gridProperties.frozenRowCount` when `freeze_rows`. `fields` masks set precisely.
- `batch_update{spreadsheet, requests:array}` (raw escape hatch) → validate `requests` is a non-empty array of objects (`ValidationError` otherwise) → `client.batchUpdate(id, requests)` → `{replies}`.

- [ ] Tests first → FAIL → implement → PASS → Commit `feat(sheets-smart): structure/format + raw batch_update tools`.

### Task 8: `tools/sharing.ts` — `share_sheet`, `quick_add_row`; `tools/index.ts` registry

**Files:** Create `src/tools/sharing.ts`, `src/tools/index.ts`; Test `src/tools/__tests__/sharing.test.ts`, `src/__tests__/wire.test.ts`.

- `share_sheet{spreadsheet, role, type, email?, notify?=true, confirm?=false}` → validate (`type==="user"`→`email` required); `guardDestructive({confirm, preview:"Share "+id+" as "+role+" with "+(email??type)})`; `client.createPermission(id,{role,type,emailAddress:email},{sendNotificationEmail:notify})`; then `client.getWebViewLink(id)` → `{permission_id, web_view_link}`.
- `quick_add_row{spreadsheet, values:any[], tab?}` → `range = tab ? quoteSheetTitle(tab) : "A1"`; `client.appendValues(id, range, [values], "USER_ENTERED", "INSERT_ROWS")` → `{updated_range}`.
- `index.ts`: `export const tools = [list_sheets, create_sheet, get_sheet, delete_sheet, read_range, write_range, append_rows, update_cells, clear_range, add_tab, rename_tab, delete_tab, format_range, batch_update, share_sheet, quick_add_row]` (16).
- `wire.test.ts`: assert `tools.length === 16`, all names unique snake_case, all descriptions ≤ 60 chars.

- [ ] Tests first → FAIL → implement → PASS → Commit `feat(sheets-smart): sharing + quick-add + tool registry`.

---

## Phase 5 — Build & verify (autonomous)

### Task 9: Green build, lint, full test, server smoke

- [ ] `npm run build --workspace=sheets-smart` → clean.
- [ ] `npm run typecheck --workspace=sheets-smart` → clean.
- [ ] `npm run lint --workspace=sheets-smart` → clean (fix any).
- [ ] `npm test --workspace=sheets-smart` → all PASS; note count.
- [ ] Smoke: pipe a JSON-RPC `initialize` + `tools/list` into `node packages/sheets-smart/dist/server.js`, assert response lists 16 tool names. (Server needs no token to list tools.)
- [ ] Commit: `test(sheets-smart): full suite + tools/list smoke green`.

---

## Phase 6 — Consent handoff (ONLY human step)

### Task 10: Mint token + register

- [ ] **Hand Santo one command** to run via `!`:
  `node /home/oneknight/projects/tools/smart-mcps/packages/sheets-smart/dist/bin/sheets-smart-auth.js your-account`
  He approves the Google consent (Advanced → continue past unverified-app warning). Confirms `~/.santo-agent/oauth/your-account.sheets.json` written.
- [ ] Verify token file exists with both scopes (read scopes array; do not print secrets).
- [ ] `./scripts/install-clients.sh sheets-smart` → confirm `~/.claude.json` has `mcpServers.sheets-smart`.

---

## Phase 7 — End-to-end proof + cleanup

### Task 11: Create the loan ledger through the real client; verify; retire .md

- [ ] Run a one-shot node script that imports the BUILT `SheetsClient` (`dist/`) for account `your-account` and calls the real `create_sheet` + `write_range`/`batch_update` path to build "Loan Repayment Ledger" (summary block + payments table + USER_ENTERED running-balance formulas + currency formatting + frozen header), exactly the content from `~/Documents/loan-ledger.md`.
- [ ] Read the sheet back via `getValues`/`getSpreadsheet`; assert Original=1657, Total paid=257, Remaining=1400 compute live; print `spreadsheetUrl`.
- [ ] Show Santo the live URL. On his confirmation it renders right, delete `~/Documents/loan-ledger.md` and update memory `project_loan_ledger.md` + `MEMORY.md` to point at the sheet (id + url) and note sheets-smart owns updates.
- [ ] Update `smart-mcps` memory (`project_smart_mcps_personal.md`) and README: phase 6 sheets-smart shipped, 16 tools.
- [ ] Final commit: `docs(sheets-smart): README + phase-6 shipped`.

---

## Self-review

- **Spec coverage:** all 16 tools (§5) → Tasks 5-8; auth (§4) → Task 1; sheet-ref (§6) → Task 2; extensibility `runBatch`/`batch_update` (§5 Power) → Task 7; tests (§7) → every task + Task 9; registration (§8) → Task 10; proof + cleanup (§1) → Task 11; pre-flight (§9) already satisfied. No gaps.
- **Placeholders:** none — each tool's client method, args, and output shape are explicit.
- **Type consistency:** client method names in Task 3 match calls in Tasks 5-8; `SheetsContext`/`buildContext` consistent across Tasks 4-8; `parseSpreadsheetId`/`quoteSheetTitle` (Task 2) used in Tasks 5/8.
