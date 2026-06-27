# Phase 6 — sheets-smart design

**Date:** 2026-06-27
**Status:** Design (approved scope/access; pending spec review)
**Research backing:** `docs/research/2026-06-27-sheets-smart-google-api-mcp.md` (all API shapes verified against current official docs)
**Pattern source:** mirrors `packages/calendar-smart`

## 1. Purpose

A persistent MCP server giving the agent full read/write control of Google Sheets in Santo's personal Google account — create, find, read, write, append, format, restructure, share — reachable every session as `mcp__sheets-smart__*`, exactly like calendar-smart/email-smart. Replaces one-off scripts.

First proof-of-work after build: create Santo's loan-repayment ledger through the tool end-to-end, then retire the throwaway markdown.

## 2. Goals / non-goals

**Goals**
- Full Sheets workhorse: the ~15 tools in §5.
- Single OAuth token (`spreadsheets` + `drive` scopes) for the default personal account; multi-account capable.
- Accept a spreadsheet by **ID or full URL** everywhere.
- One generic `batchUpdate` plumbing path so later "automation/beautify" (conditional formatting, charts, data validation, banding) bolts on without new transport code.

**Non-goals (v1)**
- Conditional formatting / charts / data validation / Apps Script tools (architecture leaves the hook open; not built now — YAGNI).
- A GUI. Bytes upload/`.xlsx` import. Shared-drive/org features beyond what the personal account needs.

## 3. Architecture

Mirrors calendar-smart precisely; only the API surface differs.

```
packages/sheets-smart/
  package.json            name "sheets-smart"; bins sheets-smart, sheets-smart-auth; deps smart-mcp-core, @modelcontextprotocol/sdk ^1.12.0, zod
  tsconfig.json           extends ../../tsconfig.base.json; references ../core
  vitest.config.ts
  src/
    server.ts             #!/usr/bin/env node — createMcpServer({ name, version, tools, context })
    context.ts            loadCreds; SHEETS_DEFAULT_IDENTITY env -> default "your-account"; builds SheetsClient
    client.ts             REST client: SHEETS_API_BASE + DRIVE_API_BASE, GoogleOAuthClient(fileSuffix ".sheets.json"), fetchJson, error mapping
    sheet-ref.ts          parse spreadsheet ID from raw ID or docs.google.com URL; A1 range helpers
    mappers.ts            slim response shapes (spreadsheet metadata, value ranges, file listings)
    null-helpers.ts
    bin/sheets-smart-auth.ts   loopback consent -> ~/.santo-agent/oauth/<account>.sheets.json (0600)
    tools/
      index.ts            tool registry (grouped)
      spreadsheets.ts     create / get / list / delete
      values.ts           read / write / append / update_cells / clear
      structure.ts        add_tab / rename_tab / delete_tab / format_range
      sharing.ts          share / quick_add_row
    __tests__/ , tools/__tests__/ , bin/__tests__/   vitest + msw
```

**Constants (`client.ts`):**
- `SHEETS_API_BASE = "https://sheets.googleapis.com/v4"`
- `DRIVE_API_BASE  = "https://www.googleapis.com/drive/v3"`
- `SHEETS_TOKEN_FILE_SUFFIX = ".sheets.json"`
- `SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]`

**Core API consumed (from `smart-mcp-core`):** `createMcpServer`, `defineTool`, `GoogleOAuthClient(account, {home, fileSuffix, reauthHint, requiredScope})` → `getAccessToken()`/`hasScope()`, `fetchJson(url, {token, method, body})` (maps 400→Validation, 401/403→Auth, 404→NotFound, 429→RateLimit, 5xx→Upstream), `loadCreds`, `guardDestructive({confirm, preview})`.

## 4. Auth

- `sheets-smart-auth <account>` bin = clone of `calendar-smart-auth.ts`, changing only the scope set (`SHEETS_SCOPES`, space-joined in the auth URL) and token suffix (`.sheets.json`). Loopback on `127.0.0.1:<ephemeral>`, `access_type=offline`, `prompt=consent`. Writes `{token, refresh_token, token_uri, client_id, client_secret, scopes, expiry}` at 0600.
- GCP project `shanto-agent`: consent screen **In production** (verified — no 7-day expiry), Sheets API + Drive API **enabled** (verified).
- Consent shows an unverified-app warning (restricted `drive` scope) → Advanced → continue. Expected, personal use.
- PKCE: not in current house bin; treated as optional future hardening, out of v1 scope.

## 5. Tool surface (v1 — full set)

All tool names snake_case; every spreadsheet arg accepts ID or URL; account optional (defaults to the configured identity).

| Group | Tool | Inputs (key) | Returns | API |
|---|---|---|---|---|
| Discover/lifecycle | `list_sheets` | `query?`, `page_size?`, `page_token?` | `{sheets:[{id,name,modified_time,url}], next_page_token}` | Drive files.list, `q=mimeType='...spreadsheet' and trashed=false [and name contains '<q>']` |
| | `create_sheet` | `title`, `folder_id?`, `tabs?`, `seed?` (rows/headers) | `{spreadsheet_id, url, sheets:[{sheet_id,title}]}` | Sheets create (+ Drive files.update addParents if `folder_id`) |
| | `get_sheet` | `spreadsheet` | `{title, url, tabs:[{sheet_id,title,rows,cols,frozen_rows}], named_ranges}` | Sheets get (fields mask) |
| | `delete_sheet` | `spreadsheet`, `permanent?` (default false), `confirm` | `{trashed\|deleted}` | Drive trash (default) / files.delete |
| | `share_sheet` | `spreadsheet`, `role`, `type`, `email?`, `notify?`, `confirm` | `{permission_id, web_view_link}` | Drive permissions.create (+ files.get webViewLink) |
| Values | `read_range` | `spreadsheet`, `range`, `value_render?`, `major_dimension?` | `{range, values}` | values.get |
| | `write_range` | `spreadsheet`, `range`, `values`, `value_input_option?` (default USER_ENTERED) | `{updated_range, updated_cells}` | values.update |
| | `append_rows` | `spreadsheet`, `range`, `values`, `value_input_option?`, `insert_option?` (default INSERT_ROWS) | `{updated_range, updated_rows}` | values.append |
| | `update_cells` | `spreadsheet`, `data:[{range,values}]`, `value_input_option?` | `{total_updated_cells}` | values.batchUpdate |
| | `clear_range` | `spreadsheet`, `range` | `{cleared_range}` | values.clear |
| Structure/format | `add_tab` | `spreadsheet`, `title`, `rows?`, `cols?` | `{sheet_id, title}` | batchUpdate addSheet |
| | `rename_tab` | `spreadsheet`, `sheet_id`, `title` | `{sheet_id, title}` | batchUpdate updateSheetProperties |
| | `delete_tab` | `spreadsheet`, `sheet_id`, `confirm` | `{deleted_sheet_id}` | batchUpdate deleteSheet |
| | `format_range` | `spreadsheet`, `sheet_id`, `range` (A1 or grid), `bold?`, `number_format?`, `background?`, `freeze_rows?` | `{applied}` | batchUpdate repeatCell/updateSheetProperties |
| Shortcut | `quick_add_row` | `spreadsheet`, `values`, `tab?` | `{updated_range}` | values.append on first/named tab |
| Power | `batch_update` | `spreadsheet`, `requests` (raw Google `Request[]`) | `{replies}` | raw spreadsheets:batchUpdate |

`batch_update` is the full-power escape hatch (Santo: full scope): it forwards an arbitrary `requests[]` array to `spreadsheets:batchUpdate`, unlocking every structural/format/chart/conditional-format/data-validation operation on day one without waiting for typed wrappers. Inputs are validated as well-formed JSON objects but not against Google's per-request schema (the API rejects malformed requests atomically). The typed tools above remain the ergonomic, safe path for common ops. 16 tools total.

Destructive tools (`delete_sheet`, `delete_tab`, `share_sheet`) require `confirm: true` via `guardDestructive`, which surfaces a human-readable preview first. `delete_sheet` defaults to **trash** (30-day recoverable), not hard-delete.

### Generic batch plumbing (extensibility)
`structure.ts` wraps `POST /spreadsheets/{id}:batchUpdate` behind one internal `runBatch(spreadsheet, requests[])`. `format_range`, `add_tab`, `rename_tab`, `delete_tab` all emit request objects into it. Future tools (`add_conditional_format`, `add_chart`, `set_data_validation`) become new request builders feeding the same path — no new transport.

## 6. Key behaviors / correctness

- **Sheet ref:** `sheet-ref.ts` extracts the ID from `https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0` or a bare ID; rejects malformed input with `ValidationError`.
- **Formulas/dates:** writes default `valueInputOption=USER_ENTERED` (so `=SUM(...)`, dates, currency parse); `RAW` available via `value_input_option`.
- **Append safety:** defaults `insertDataOption=INSERT_ROWS` to avoid clobbering data below a table; the `range` is documented as a search hint.
- **Structural indices:** `format_range`/tab ops use 0-based half-open `GridRange` keyed on `sheet_id`; when a tool is given an A1 range, it resolves `sheet_id` + indices via `get_sheet` first.
- **Errors:** Google error bodies mapped through core classes; auth failures append the `reauthHintFor(account)` re-auth command. 429 surfaces as `RateLimitError` (caller/back-off concern; v1 does not auto-retry — documented).
- **Quota:** writes batched where possible (60/min/user ceiling).

## 7. Testing

Vitest + msw, colocated `__tests__/`. Coverage:
- `sheet-ref` parser (ID, URL variants, junk).
- A1/grid range helpers.
- Each tool: metadata assertions + handler shaping against a mocked Google endpoint (fake client), incl. USER_ENTERED default, append INSERT_ROWS default, trash-vs-delete branch, confirm-gate on destructive tools.
- Auth bin: injected `codeReader`/`now` seams, token file contents + 0600 mode, token-exchange POST shape.
No live API calls in tests. `HOME` overridden per-test (token jar isolation).

## 8. Registration & build

- `npm run build --workspace=sheets-smart` (`tsc` + chmod bins).
- `node packages/sheets-smart/dist/bin/sheets-smart-auth.js your-account` (one-time consent).
- `./scripts/install-clients.sh sheets-smart` → writes `~/.claude.json` `mcpServers.sheets-smart = {command:"node", args:[".../dist/server.js"]}`.
- Restart Claude Code; `/mcp` shows sheets-smart with 16 tools.

## 9. Pre-flight (satisfied)

- [x] Consent screen In production (no 7-day refresh expiry)
- [x] Sheets API enabled
- [x] Drive API enabled
- [x] Desktop OAuth client present (`Shanto-Agent-Desktop`, `client.json`)

## 10. Open questions

- Apostrophe-in-tab-name A1 escaping (UNVERIFIED in docs) — handle defensively in `sheet-ref` quoting; add a test if it ever bites.
- ~~Raw `batch_update` escape hatch?~~ **Resolved 2026-06-27: include it** (Santo: full scope) — see §5 Power group.
