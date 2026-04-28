# email-smart MVP (Phase 3) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task in this session. Each task gets a fresh implementer subagent + spec reviewer + code quality reviewer.

**Goal:** Ship `email-smart` MCP — Gmail-backed multi-account send + inbox read + reversible-modify (mark-read / archive / trash / label) + smart shortcuts. Wraps the existing `~/.santo-agent` token jar and identities. ~18 tools total. All unit tests green.

**Architecture:** New workspace `packages/email-smart/`. Imports `smart-mcp-core` for errors/http/confirm/server. **Does NOT use `loadCreds`** for the API key path (no API key — OAuth refresh tokens). Instead, a new `src/oauth.ts` reads per-account refresh-token JSON from `~/.santo-agent/oauth/<account>.json` and exchanges for short-lived access tokens via the Google OAuth `token` endpoint. One `EmailClient` class wraps Gmail REST API at `https://gmail.googleapis.com/gmail/v1`. Tools split into thin files (`send.ts`, `identities.ts`, `audit.ts`, `inbox.ts`, `modify.ts`, `labels.ts`, `smart.ts`). Tests use `msw` to mock both `oauth2.googleapis.com/token` and `gmail.googleapis.com`.

**Tech Stack:** Same as Phases 1-2 — TypeScript 5.7 ESM, Node 22+, vitest 2.1, msw 2.6, zod 3.24, `@modelcontextprotocol/sdk` 1.12. New runtime dep: `yaml` (≥2.6) for parsing identity files. No new core changes required (`fetchJson`, `AuthError`, `NotFoundError`, `RateLimitError`, `guardDestructive`, `defineTool`, `createMcpServer` all reusable).

**Scope expansion (deliberate):** Existing `~/.santo-agent` is `gmail.send` only. This phase expands to `gmail.modify`, which covers send + read + label + archive + trash. **Does NOT include `gmail.delete`** (permanent delete) — trash auto-purges in 30 days, which preserves the original "no full-mailbox-nuke" intent. The santo-agent README hard-rule line "Scope is `gmail.send` only" gets updated in Task 1 to reflect the new scope set.

**Multi-account by design:** Every tool requires an explicit `account: string` input — no silent default (mirrors santo-agent's `--account required` rule). Currently configured: `your-account`. Planned: `utd` (UTD Workspace EDU; depends on UTD IT allowing third-party OAuth Desktop apps — see Task 1).

**Gmail REST API endpoints (locked in by research, 2026-04-28):**
- Base: `https://gmail.googleapis.com/gmail/v1`
- OAuth token refresh: `POST https://oauth2.googleapis.com/token` (form-encoded, `grant_type=refresh_token`)
- Auth on Gmail calls: `Authorization: Bearer <access_token>`
- Send: `POST /users/me/messages/send` (body `{ raw: <base64url MIME> }`)
- List messages: `GET /users/me/messages?q=<query>&maxResults=<n>&pageToken=<t>&labelIds=<l>`
- Get message: `GET /users/me/messages/{id}?format=metadata|full|raw|minimal`
- Get thread: `GET /users/me/threads/{id}?format=metadata|full`
- Batch modify: `POST /users/me/messages/batchModify` (body `{ ids: string[], addLabelIds?: string[], removeLabelIds?: string[] }`)
- Batch trash: `POST /users/me/messages/batchTrash` (body `{ ids: string[] }`) — single-shot trash, irreversible-after-30-days
- List labels: `GET /users/me/labels`
- Full reference: <https://developers.google.com/workspace/gmail/api/reference/rest>

**Per-account refresh-token file shape (written by `bin/auth.py`):**
```json
{
  "token": "ya29.a0Ad...",
  "refresh_token": "1//0g...",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "...apps.googleusercontent.com",
  "client_secret": "GOCSPX-...",
  "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
  "expiry": "2026-04-28T18:00:00.000000Z"
}
```

**Identity yaml shape (extended):**
```yaml
account: your-account
email: your-account@gmail.com
display_name: Shanto
default_footer: ...
default_reply_to: your-account@gmail.com
signature_html: |
  ...
signature_text: |
  ...
transport: oauth         # NEW (defaults to "oauth"; "smtp" reserved for Phase 3.5+ UTD fallback)
```

**Notes baked into plan:**
- The existing Python `bin/send-email.py` keeps working unchanged after the SCOPES bump (broader scope still permits send). No need to remove or migrate it; the MCP coexists.
- Audit log path stays `~/.santo-agent/audit/send-log.jsonl` — both Python and TS append to the same JSONL. Format must match exactly so `list_recent_sends` works on entries written by either.
- HTML template stays at `~/.santo-agent/templates/email-base.html`. The MCP reads it at render time; no need to bundle.
- Token refresh: Gmail access tokens expire ~1 hour. The MCP caches access tokens in memory per-account, refreshes lazily on every Gmail call (`if expiry < now + 60s, refresh`). On refresh, write the new access token + new expiry back to `~/.santo-agent/oauth/<account>.json` (preserves the file as the canonical state, matching Python behavior).
- Token file mode: must be 0600 after every write. Use `fs.chmodSync(path, 0o600)`.
- `gmail.modify` scope **does NOT** allow `users.messages.delete` (permanent delete) — only `batchTrash`. This is the deliberate guardrail.
- Gmail rate limits: 250 quota units / user / second. `messages.send` = 100 units; `batchModify` = 50; `messages.list` = 5; `messages.get` = 5. Built-in `fetchJson` 429 retry handles transient overages.

---

## Pre-phase manual user setup (one-time, performed BEFORE Task 2)

Task 1 below contains the code changes needed. Then the user must:

1. Open Google Cloud Console → existing Gmail-API project → OAuth consent screen → ensure scopes include `https://www.googleapis.com/auth/gmail.modify` (in addition to or replacing `gmail.send`). Save.
2. Re-run auth bootstrap for each account:
   ```
   python3 ~/.santo-agent/bin/auth.py --account your-account
   python3 ~/.santo-agent/bin/auth.py --account utd
   ```
   Browser opens, sign in, consent to broader scope, refresh token rewritten.
3. **UTD-specific:** if step 2 for `utd` fails with "Access blocked: This app's request is invalid" or similar, UTD Workspace IT has restricted third-party OAuth Desktop apps. Two options:
   - (a) Skip UTD on this phase. `email-smart` ships with `your-account` only. UTD lands later via Phase 3.5 SMTP-transport addendum (App Password + nodemailer).
   - (b) Ask UTD IT to allowlist the OAuth client ID. Unlikely for personal use.
4. Add a new identity yaml `~/.santo-agent/identities/utd.yaml` (Task 1 ships a template).

---

## Conventions for the implementer subagent

Same as Phases 1-2:
1. Strict TDD. Red → green → refactor → commit.
2. Commit after every task. Conventional commits (`feat(email-smart): ...`).
3. NO fixtures referencing real recipients. Use `alpha@example.com`, `beta@example.com`, `gamma@test`. NO real email subject lines.
4. Network forbidden in tests. Use `msw` for every Google call (oauth2 + gmail).
5. Tool descriptions terse (≤ 15 tokens).
6. Read-only tools never take `confirm`. All write/destructive tools take `confirm: boolean` (and `dry_run: boolean` for batch ops) and use `guardDestructive`.
7. All API errors flow through `smart-mcp-core`'s `fetchJson` and `defineTool` — do not invent new error paths. 401 → `AuthError("token at ~/.santo-agent/oauth/<account>.json invalid or revoked; re-run bin/auth.py")`. 403 → surface scope info.
8. NO emojis. NO unicode in note strings. NO mentions of AI/Claude/Anthropic/former-employer.
9. `account: z.string().min(1)` is REQUIRED on EVERY tool. No `.optional()`. No silent default. (Hard rule from santo-agent README, preserved.)
10. **Test isolation gotcha:** any test that asserts "missing token throws AuthError" MUST override `process.env.HOME` to a non-existent dir in `beforeEach`. Otherwise the OAuth loader falls back to the real `~/.santo-agent/oauth/...` and the test silently passes. Same pattern as `vercel-smart/src/__tests__/client.test.ts` (saved/restored: `HOME`).
11. **No real Gmail API calls in tests, ever.** `msw` intercepts `oauth2.googleapis.com` and `gmail.googleapis.com` at the HTTP layer.

---

## Task list

### Task 1: Expand santo-agent OAuth scope to `gmail.modify` + identity yaml `transport` field

NOT a TS task. Updates to the existing Python tooling so the MCP picks up broader-scope tokens.

**Files to edit:**
- `~/.santo-agent/bin/auth.py`: change `SCOPES` constant from `["https://www.googleapis.com/auth/gmail.send"]` to `["https://www.googleapis.com/auth/gmail.modify"]`.
- `~/.santo-agent/bin/send-email.py`: change `SCOPES` constant identically (so `Credentials.from_authorized_user_file` validates against the new scope).
- `~/.santo-agent/README.md`: update the "Hard rules" section. Replace "Scope is `gmail.send` only" with "Scope is `gmail.modify` (send + read + reversible label/archive/trash). Never `gmail.delete` or `https://mail.google.com/`." Keep the "Tokens live in `oauth/`, mode 0600" rule.
- Create template `~/.santo-agent/identities/utd.yaml.template` (committed to a separate user-managed location, NOT to smart-mcps repo) — but the template content is documented here for reference:
  ```yaml
  account: utd
  email: <netid>@utdallas.edu
  display_name: Shifat Islam
  default_footer: Sent from my UTD account.
  default_reply_to: <netid>@utdallas.edu
  signature_html: |
    Shifat Islam<br>
    University of Texas at Dallas
  signature_text: |
    Shifat Islam
    University of Texas at Dallas
  transport: oauth
  ```
- Existing `~/.santo-agent/identities/your-account.yaml`: append one line `transport: oauth` at end.

**No commit yet** — these are user-machine-local changes (santo-agent is not in this repo). User performs manually using the diffs above. After this task, the user runs the two `auth.py` invocations from the "Pre-phase manual setup" section.

(If at this point UTD blocks OAuth, proceed without UTD — design supports it cleanly.)

### Task 2: Scaffold `packages/email-smart` workspace

Mirror the runpod-smart scaffold task. Files:
- `package.json` — name `email-smart`, deps `smart-mcp-core: "*"`, `@modelcontextprotocol/sdk ^1.12`, `zod ^3.24`, `yaml ^2.6`. Scripts: `build`, `test`, `typecheck`, `lint`, `smoke`.
- `tsconfig.json` — composite, references `../core`, extends `../../tsconfig.base.json`.
- `vitest.config.ts` — `globals: true`, `environment: "node"`.
- `src/server.ts` — placeholder default-export.
- `src/tools/index.ts` — placeholder empty array.
- `README.md` — placeholder ("Phase 3 in progress").
- `src/__tests__/.gitkeep`.

`npm install` from repo root after adding `yaml` so package-lock.json updates.

Commit: `chore(email-smart): scaffold workspace`

### Task 3: `GoogleOAuthClient` — refresh-token → access-token flow (TDD)

New file `src/oauth.ts`. Class encapsulates the per-account token lifecycle.

```ts
type AuthorizedUserFile = {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;  // ISO timestamp
};

class GoogleOAuthClient {
  constructor(private readonly account: string, private readonly home: string = process.env.HOME!) {}
  async getAccessToken(): Promise<string>;     // refresh if < 60s to expiry, write back to disk, chmod 600
  getTokenPath(): string;                       // ~/.santo-agent/oauth/<account>.json
  hasGmailModifyScope(): Promise<boolean>;      // for verify_account tool later
}
```

Tests in `src/__tests__/oauth.test.ts` (use `msw` for `https://oauth2.googleapis.com/token`):
1. Loads `<HOME>/.santo-agent/oauth/<account>.json`. Returns cached token when expiry > now + 60s.
2. Refreshes when expiry < now + 60s. Posts form-encoded body with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`.
3. After refresh, writes the updated file back: same shape, new `token`, new `expiry` (computed `now + expires_in`), `refresh_token` preserved (Google does not return one on refresh).
4. After write, file mode is 0600 (assert via `fs.statSync`).
5. Missing token file throws `AuthError("token at <path> not found; run python3 ~/.santo-agent/bin/auth.py --account <account>")`. **Test must override HOME to non-existent dir.**
6. 400/invalid_grant from token endpoint throws `AuthError("refresh token revoked; re-run bin/auth.py --account <account>")`.
7. Two consecutive `getAccessToken()` calls inside cache window do NOT hit the network (msw assertion).
8. Two consecutive calls AFTER cache expires hit the network exactly once (single in-flight refresh, deduped).
9. `hasGmailModifyScope` returns true when scopes include `gmail.modify`, false otherwise.
10. Use `vi.useFakeTimers()` to make expiry math deterministic.

≥10 tests.

Commit: `feat(email-smart): GoogleOAuthClient with cached refresh + chmod 600`

### Task 4: `IdentityLoader` + `MimeBuilder` modules (TDD)

Two new files, both pure (no network).

`src/identities.ts`:
```ts
type Identity = {
  account: string;
  email: string;
  display_name: string;
  default_footer?: string;
  default_reply_to?: string;
  signature_html?: string;
  signature_text?: string;
  transport: "oauth" | "smtp";
};

function loadIdentity(account: string, home?: string): Identity;       // throws NotFoundError if file missing
function listIdentities(home?: string): Identity[];                    // reads ~/.santo-agent/identities/*.yaml
```

Tests (≥6):
1. `loadIdentity` reads + parses YAML, applies `transport: "oauth"` default when field missing.
2. `loadIdentity` throws `NotFoundError("identity not found: <account>")` when file missing. **Override HOME.**
3. `listIdentities` returns all `*.yaml` in dir, sorted by account.
4. Returns `[]` when dir missing.
5. Skips files that fail YAML parse (logs to stderr, does not crash). Test with one valid + one corrupt file.
6. Required fields enforced: missing `email` throws; missing `display_name` throws.

`src/mime.ts`:
```ts
function buildRawMessage(opts: {
  identity: Identity;
  to: string;        // comma-separated
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
}): string;          // returns base64url-encoded MIME
```

Tests (≥10):
1. From header is `formataddr` shape: `"Display Name <email@domain>"`.
2. Subject UTF-8 encoded if non-ASCII (RFC 2047 `=?utf-8?B?...?=`).
3. multipart/alternative boundary present, plaintext part FIRST, HTML part SECOND (RFC 2046 — clients pick last preferred).
4. `Reply-To` defaults to `identity.default_reply_to` if not provided, else `identity.email`.
5. `Date` header is RFC 5322 format.
6. `Message-ID` is `<uuid@<domain-from-email>>`.
7. Default headers always set: `Auto-Submitted: no`, `X-Mailer`, `X-Sent-By-Agent: smart-mcps-email/1.0`, `X-Agent-Operator`.
8. Custom `headers` map overrides defaults.
9. CC and BCC headers absent when empty.
10. Output is base64url (no padding `=`, `-` and `_` instead of `+` and `/`).

Commit: `feat(email-smart): identity loader + RFC2822 MIME builder`

### Task 5: `EmailClient.sendMessage` + tool `send_email` (TDD — destructive headline)

Client class `src/client.ts`:
```ts
class EmailClient {
  constructor(private readonly home: string = process.env.HOME!) {}
  // Caches one GoogleOAuthClient per account.
  private oauthFor(account: string): GoogleOAuthClient;
  async sendMessage(account: string, raw: string): Promise<{ id: string; threadId: string; labelIds: string[] }>;
}
```

`sendMessage` flow:
1. Get access token from `oauthFor(account)`.
2. POST `https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `Authorization: Bearer <token>` and JSON body `{ raw }`.
3. Map 401 → `AuthError`, 403 → `AuthError("scope insufficient — re-run bin/auth.py --account <account> after expanding scope to gmail.modify")`, 429 → handled by `fetchJson` retry, 400 → throw with body for diagnosis.
4. Returns parsed body `{ id, threadId, labelIds }`.

Audit log helper `src/audit.ts` (append-only JSONL):
```ts
type AuditEntry = {
  ts: string;       // ISO
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  gmail_id: string;
  gmail_thread_id: string;
};

function appendAudit(entry: AuditEntry, home?: string): void;     // writes to ~/.santo-agent/audit/send-log.jsonl
function readAudit(home?: string): AuditEntry[];                  // last-N or stream; for tools later
```

Format **must match exactly** what Python `bin/send-email.py` writes (test by round-tripping a Python-generated entry through `readAudit`). Field order: `ts`, `account`, `to`, `cc`, `bcc`, `subject`, `gmail_id`, `gmail_thread_id`.

Tool `send_email` in `src/tools/send.ts`:
- name: `"send_email"`
- desc: `"Send HTML+text email via Gmail (multi-account)."`
- input:
  ```ts
  z.object({
    account: z.string().min(1),
    to: z.string().min(1),                      // comma-separated
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().min(1),
    html: z.string().min(1),
    text: z.string().min(1),
    reply_to: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    confirm: z.boolean().optional().default(false),
  })
  ```
- output: `{ gmail_id: string; thread_id: string; from: string; to: string; subject: string; sent_at: string }`

Behavior:
1. Load identity for `account`.
2. Build preview: `"Will send to <to> from <identity.display_name> <<identity.email>>: \"<subject>\""`. If `cc` or `bcc` set, append.
3. `guardDestructive({ confirm, preview })`.
4. Build raw MIME via `buildRawMessage`.
5. `client.sendMessage(account, raw)`.
6. Append audit entry.
7. Return slim shape with the new `gmail_id`.

≥12 tests including: confirm gate, preview text exact-match, identity not-found error, raw bytes correctness via mock body capture, audit-log appended on success, audit-log NOT appended on Gmail 400 failure, scope-insufficient 403 error message.

Commit: `feat(email-smart): send_email with confirm gate + audit log`

### Task 6: Tool `send_with_template` (TDD)

Reads `~/.santo-agent/templates/email-base.html`, performs simple `{{var}}` substitution, then sends.

`src/templates.ts`:
```ts
function loadTemplate(name: string, home?: string): string;            // throws NotFoundError if missing
function renderTemplate(template: string, vars: Record<string,string>): string;  // {{key}} → value, missing key → throw
function deriveTextFromHtml(html: string): string;                     // very simple strip-tags fallback
```

Tool spec:
- name: `"send_with_template"`
- desc: `"Send templated HTML email with variable substitution."`
- input:
  ```ts
  z.object({
    account: z.string().min(1),
    template: z.string().min(1).default("email-base"),   // file basename without .html
    to: z.string().min(1),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().min(1),
    vars: z.record(z.string(), z.string()),               // body, intro, cta_url, etc.
    text_override: z.string().optional(),                 // if omitted, derive from HTML
    reply_to: z.string().optional(),
    confirm: z.boolean().optional().default(false),
  })
  ```
- output: same as `send_email`

Behavior: load template → require `vars.body` minimum → auto-inject `signature_html` from identity → render → derive text → guard → send → audit.

≥6 tests including missing-var error, signature injection, text fallback derivation, identity-driven signature, confirm gate.

Commit: `feat(email-smart): send_with_template renderer + tool`

### Task 7: Tools `list_identities`, `get_identity`, `list_recent_sends`, `search_audit` (TDD — read-only)

All four tools touch only the local filesystem (no Gmail API).

`list_identities`:
- desc: `"List all configured Gmail accounts."`
- input: `z.object({})`
- output: `{ identities: Array<{ account, email, display_name, transport }>, count }`

`get_identity`:
- desc: `"Show full identity record for an account."`
- input: `z.object({ account: z.string().min(1) })`
- output: full Identity shape minus signature_html (too noisy by default — add `include_signature: z.boolean().optional().default(false)`).

`list_recent_sends`:
- desc: `"Recent sent-email log entries (paginated)."`
- input: `z.object({ account: z.string().optional(), limit: z.number().int().min(1).max(200).optional().default(20), offset: z.number().int().min(0).optional().default(0) })`
- output: `{ entries: AuditEntry[], total, returned }`. Filter by account if provided. Reverse-chronological (newest first).

`search_audit`:
- desc: `"Search past sends by recipient, subject, or date."`
- input:
  ```ts
  z.object({
    account: z.string().optional(),
    to_contains: z.string().optional(),
    subject_contains: z.string().optional(),
    since: z.string().optional(),       // ISO
    until: z.string().optional(),       // ISO
    limit: z.number().int().min(1).max(500).optional().default(50),
  })
  ```
- output: `{ entries: AuditEntry[], matched: number }`

≥4 tests per tool (16+ total). Use `os.tmpdir()` + write fixture JSONL files with known content, override HOME for the duration of the test, restore in afterEach.

Commit: `feat(email-smart): identity + audit read tools`

### Task 8: Client read methods + tools `list_inbox`, `search_emails`, `read_email`, `get_thread`, `bulk_read_messages` (TDD)

Add to client:
- `listMessages(account, opts: { q?, maxResults?, pageToken?, labelIds? })` → `GET /users/me/messages?...` → `{ messages: Array<{id, threadId}>, nextPageToken?, resultSizeEstimate }`
- `getMessage(account, id, format = "metadata")` → `GET /users/me/messages/{id}?format=...`
- `getThread(account, id, format = "metadata")` → `GET /users/me/threads/{id}?format=...`

All map 404 → `NotFoundError`. List handles pagination via `pageToken`.

Slim mapper `src/message-mapper.ts`:
```ts
type SlimMessage = {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  size_bytes: number;
};
function mapMessage(raw: unknown): SlimMessage;
```
Pulls headers (`From`, `To`, `Subject`, `Date`) out of `payload.headers[]`.

Tools in `src/tools/inbox.ts`:

`list_inbox` — desc `"List recent inbox messages (slim shape)."`. Input: `{ account, max_results?: 10, label?: "INBOX" }`. Calls `listMessages` then maps each ID via `getMessage(format=metadata)`. ≥4 tests.

`search_emails` — desc `"Search Gmail with query syntax."`. Input: `{ account, q, max_results?: 25 }`. `q` passes through to Gmail (e.g. `from:newsletter older_than:7d`). ≥6 tests including query passthrough, pagination handling.

`read_email` — desc `"Read full email body by ID."`. Input: `{ account, id, format?: "full" }`. Output: SlimMessage extended with `body_html?: string, body_text?: string` extracted from `payload.parts`. ≥4 tests including multipart parsing.

`get_thread` — desc `"Read full email thread by ID."`. Input: `{ account, id }`. Output: `{ id, subject, message_count, messages: SlimMessage[] }`. ≥3 tests.

`bulk_read_messages` — desc `"Fetch slim shape for many message IDs at once."`. Input: `{ account, ids: string[] (max 100) }`. Sequential `getMessage(format=metadata)` calls (Gmail batch endpoint requires multipart-form which is heavier than worth it for MVP). ≥4 tests including 100-cap enforcement.

≥21 tests across these tools.

Commit: `feat(email-smart): inbox read tools (list, search, read, thread, bulk)`

### Task 9: Client modify methods + destructive tools `mark_read_by_query`, `archive_by_query`, `trash_by_query`, `apply_label_by_query` (TDD)

Add to client:
- `batchModify(account, opts: { ids: string[], addLabelIds?: string[], removeLabelIds?: string[] })` → `POST /users/me/messages/batchModify`. Returns 204; treat as void.
- `batchTrash(account, ids: string[])` → `POST /users/me/messages/batchTrash`. Returns 204.

All four tools share a common pattern: query → list IDs → preview → confirm → batch op.

Shared input shape (extend per-tool):
```ts
{
  account: z.string().min(1),
  q: z.string().min(1),                              // Gmail search query
  max: z.number().int().min(1).max(500).optional().default(100),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
}
```

Shared output:
```ts
{
  scanned: number;
  matched: number;
  preview: SlimMessage[];          // first 10 of matched
  applied: boolean;                // true only when not dry_run AND confirm
  failed?: Array<{ id: string; reason: string }>;
}
```

`mark_read_by_query` — desc `"Bulk mark as read by Gmail query."`. Removes `UNREAD` label.
`archive_by_query` — desc `"Bulk archive by Gmail query (removes INBOX)."`. Removes `INBOX` label.
`trash_by_query` — desc `"Bulk move to trash by Gmail query."`. Calls `batchTrash`. Preview must say "moves to Trash; auto-purged in 30 days; reversible until then".
`apply_label_by_query` — desc `"Bulk apply or remove label by query."`. Extra inputs: `add_label?: string`, `remove_label?: string`. Resolves label name → labelId via `listLabels` cache. Errors if label doesn't exist (suggest `list_labels`).

Behavior for each:
1. List up to `max` matching message IDs (paginate `listMessages` with `q`).
2. For preview, fetch metadata for first 10 (via `bulk_read_messages`-style sequential).
3. `dry_run` (default true): return `{ scanned, matched, preview, applied: false }`.
4. If `dry_run: false` AND `confirm: true`: call batch op, return `{ ..., applied: true }`.
5. If `confirm: false` and not dry_run: `guardDestructive` throws with preview text.

≥28 tests across these four tools. Use `vi.useFakeTimers()` where Gmail-query date math matters (`older_than:7d`).

Commit: `feat(email-smart): bulk modify (mark-read/archive/trash/label)`

### Task 10: Tool `list_labels` + smart shortcuts `daily_status`, `inbox_zero_dry_run` (TDD)

`list_labels` — desc `"List all Gmail labels for account."`. Input: `{ account }`. Output: `{ labels: Array<{ id, name, type, messages_total?, messages_unread?, threads_unread? }>, count }`. Calls `GET /users/me/labels` then for each label fetches detail (Gmail returns counts only on individual GET).

`daily_status` — desc `"Today's send count + unread inbox + recent failures."`:
- input: `{ account: z.string().min(1), hours: z.number().int().min(1).max(720).optional().default(24) }`
- behavior:
  1. Read audit log entries for `account` in last `hours`. Count.
  2. Call `listMessages(account, q: "is:unread")` for unread count (just `resultSizeEstimate` — don't fetch all).
  3. Scan recent send-log for any entries with no `gmail_id` (would only happen if the audit logger wrote a partial entry; treat as warning).
- output:
  ```ts
  {
    account: string;
    window_hours: number;
    sends: { total: number; recent: AuditEntry[]; latest_at: string|null };
    inbox: { unread_count: number };
    notes: string[];
  }
  ```
- ≥6 tests, fake timers.

`inbox_zero_dry_run` — desc `"Preview noise-clearing actions on inbox."`:
- input: `{ account, max?: 200 }`
- behavior:
  1. List `q: "in:inbox"` capped at `max`.
  2. Group messages by `from` domain.
  3. Identify "noise candidates": senders with ≥5 messages where the subject prefix matches common newsletter patterns (`newsletter`, `digest`, `weekly`, `unsubscribe`-header presence).
  4. Identify "stale" candidates: `older_than:30d` AND `is:unread`.
- output:
  ```ts
  {
    account: string;
    scanned: number;
    noisy_senders: Array<{ from_domain, count, sample_subjects: string[], suggested_query: string }>;
    stale_unread: Array<{ id, from, subject, date }>;
    suggested_actions: string[];   // human-readable text for LLM to relay
  }
  ```
- ≥6 tests.

Commit: `feat(email-smart): list_labels + daily_status + inbox_zero_dry_run`

### Task 11: Wire `tools/index.ts` + `server.ts` + `context.ts`

Aggregate all 18 tools:
- send: `send_email`, `send_with_template`
- identities: `list_identities`, `get_identity`
- audit: `list_recent_sends`, `search_audit`
- inbox: `list_inbox`, `search_emails`, `read_email`, `get_thread`, `bulk_read_messages`
- modify: `mark_read_by_query`, `archive_by_query`, `trash_by_query`, `apply_label_by_query`
- labels: `list_labels`
- smart: `daily_status`, `inbox_zero_dry_run`

`src/context.ts`: `EmailContext = { client: EmailClient }`. `buildContext()` returns `{ client: new EmailClient() }`.

`src/server.ts`: `createMcpServer<EmailContext>({ name: "email-smart", version: "0.1.0", tools, context: buildContext() })`. Add `chmod +x dist/server.js` postbuild.

Wire test in `src/__tests__/wire.test.ts`: tools array length is 18, all names unique, all snake_case, no duplicate descriptions.

Smoke check:
```
HOME="$HOME" timeout 3 node packages/email-smart/dist/server.js < /dev/null
```
Expect exit 0 with no real network or filesystem mutation. Constructor does NOT throw on startup (unlike vercel-smart / runpod-smart) because the EmailClient is lazy — it doesn't load any token until a tool actually invokes Gmail. Wire tests cover this.

Commit: `feat(email-smart): wire 18 tools into stdio MCP server entry`

### Task 12: README + install-clients.sh registration + tag

`scripts/install-clients.sh` already auto-discovers any built MCP — no script changes. Verify the auto-discovery finds email-smart.

Update:
- `packages/email-smart/README.md` — full doc with all 18 tools, multi-account setup steps, scope explanation, link to `~/.santo-agent` setup.
- Root `README.md` — flip `email-smart` line from "(planned)" to "(MVP shipped, 18 tools, ~220 tests)".
- Root `CLAUDE.md` — update the "Roadmap" list and the "Currently in `.env`" section. Note that `email-smart` reuses `~/.santo-agent/` and does NOT add anything to `~/.config/smart-mcps/.env`.

Final verify:
```
npm run build
npm test
```
Expected: 57 core + 135 vercel-smart + 191 runpod-smart + ~220 email-smart tests pass. All workspaces build clean.

Tag:
```
git tag -a phase-3-email-smart-mvp -m "Phase 3 MVP: 18 email-smart tools (send/template, identities, audit, inbox read, bulk modify, labels, daily_status, inbox_zero_dry_run). Wraps ~/.santo-agent OAuth tokens. gmail.modify scope. All unit tests green."
git push origin main --tags
```

Hand off live smoke to user:
1. Verify pre-phase setup done: `~/.santo-agent/oauth/your-account.json` has scope `gmail.modify`.
2. Register MCP: `./scripts/install-clients.sh email-smart` (auto-discovers).
3. Restart Claude Code, `/mcp` should list `email-smart` connected with 18 tools.
4. First test (read-only, lowest risk): `Use list_identities` then `Use list_recent_sends with limit: 5` — validates filesystem path resolution and audit log format.
5. Then read-only Gmail call: `Use list_inbox with account: "your-account", max_results: 5` — validates OAuth refresh path end to end.
6. Then dry-run destructive: `Use mark_read_by_query with account: "your-account", q: "is:unread older_than:30d", dry_run: true` — confirms preview works without mutation.
7. Then a real send to a low-stakes recipient: `Use send_email with account: "your-account", to: "<your-other-email>", subject: "smart-mcps test", html: "<p>hi</p>", text: "hi", confirm: true`.

---

## What's NOT in this plan (deferred to Phase 3.5 / email-smart-full)

- **SMTP transport for UTD-or-other accounts that block third-party OAuth.** Adds nodemailer dep + per-account `transport: smtp` branch. ~2-3 tools' worth of work; isolated.
- `bulk_send` — multi-recipient send with rate limit + per-recipient personalization. Useful for newsletter-style sends, not core MVP.
- `compose_thread` — header threading helper (`In-Reply-To` / `References`). Useful for reply chains; can be done manually via `headers` input today.
- `send_with_attachment` — multipart/mixed MIME with file attachments. Adds non-trivial MIME logic; defer.
- `bulk_unsubscribe` — parse `List-Unsubscribe` header, hit URL or send mailto. Genuinely useful, separate phase.
- Drafts: `create_draft`, `list_drafts`, `send_draft`, `update_draft`. Separate API surface.
- Filters: `list_filters`, `create_filter`. Rare use case.
- Vacation responder: `get_vacation`, `set_vacation`. Rare.
- Permanent-delete tool. **Will not be added.** Trash + 30-day auto-purge is the deliberate ceiling.
- Live integration tests against real Gmail.
- Gmail batch HTTP endpoint (`/batch/gmail/v1`) — saves round-trips for `bulk_read_messages` but multipart-form encoding overhead isn't worth the complexity at MVP scale.
- Real-time push (Pub/Sub watch) — out of scope.
- Fuzzy account resolution (e.g. `account: "shanto"` matches `your-account`) — rejected; account is required and exact-match-only by design.

These are explicitly out of scope. Add to a Phase 4 plan if/when they become needed.

---

## Resume context for next session

If a fresh Claude Code session picks this up cold, it needs to know:
- Phases 0+1+2 are SHIPPED. Tags: `phase-0-bootstrap`, `phase-1-vercel-smart-mvp`, `phase-2-runpod-smart-mvp`.
- vercel-smart and runpod-smart are INSTALLED and working in production.
- `~/.santo-agent/` is a Python email dispatcher pre-existing on the user's machine. The MCP wraps the OAuth token jar (`oauth/<account>.json`) and identity files (`identities/<account>.yaml`). Pre-phase Task 1 expanded scope from `gmail.send` to `gmail.modify`.
- Established patterns (`fetchJson` → defineTool → `guardDestructive`) are unchanged.
- New patterns introduced this phase: per-account OAuth refresh via `GoogleOAuthClient`, RFC 2822 multipart MIME builder, JSONL audit log shared with the existing Python tooling, `transport: oauth | smtp` field on identity yaml (only `oauth` implemented this phase).
- `~/.config/smart-mcps/.env` is NOT touched this phase — credentials live in `~/.santo-agent/oauth/`.
- The polish backlog from Phase 2 still applies.
