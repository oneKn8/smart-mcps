# email-smart

Multi-account Gmail MCP — send + inbox read + reversible bulk modify + drafts + bulk-unsubscribe. Wraps the existing `~/.santo-agent/` OAuth token jar. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

Scopes: `https://mail.google.com/` (the permanent-delete tools require the full mail scope; it also covers the send/read/modify surface), `gmail.settings.basic`, `gmail.settings.sharing`. Permanent-delete tools are hard-gated behind `confirm` and `dry_run`.

## Tools (27)

### Send (5)

| Name | Type | Summary |
|---|---|---|
| `send_email` | DESTRUCTIVE | Send HTML+text email via Gmail (multi-account). |
| `send_with_template` | DESTRUCTIVE | Send templated HTML email with variable substitution. |
| `send_with_attachment` | DESTRUCTIVE | Send email with file attachments (multipart/mixed, 25MB cap). |
| `compose_thread` | DESTRUCTIVE | Reply to a message — auto-sets In-Reply-To/References for thread continuity. |
| `bulk_send` | DESTRUCTIVE | Send same body to multiple recipients with rate limit + per-recipient vars. |

### Identities + audit (4, read-only)

| Name | Summary |
|---|---|
| `list_identities` | List all configured Gmail accounts. |
| `get_identity` | Show full identity record for an account. |
| `list_recent_sends` | Recent sent-email log entries (paginated). |
| `search_audit` | Search past sends by recipient, subject, or date. |

### Inbox read (5, read-only)

| Name | Summary |
|---|---|
| `list_inbox` | List recent inbox messages (slim shape). |
| `search_emails` | Search Gmail with query syntax. |
| `read_email` | Read full email body by ID. |
| `get_thread` | Read full email thread by ID. |
| `bulk_read_messages` | Fetch slim shape for many message IDs at once. |

### Bulk modify (4, DESTRUCTIVE — all support `dry_run` + `confirm`)

| Name | Summary |
|---|---|
| `mark_read_by_query` | Bulk mark as read by Gmail query. |
| `archive_by_query` | Bulk archive by Gmail query (removes INBOX). |
| `trash_by_query` | Bulk move to trash by Gmail query. Auto-purges after 30 days; reversible until then. |
| `apply_label_by_query` | Bulk apply or remove label by query. |

### Labels + smart shortcuts (3, read-only)

| Name | Summary |
|---|---|
| `list_labels` | List all Gmail labels for account (with counts). |
| `daily_status` | Today's send count + unread inbox + recent failures. |
| `inbox_zero_dry_run` | Preview noise-clearing actions on inbox (uses Gmail's CATEGORY_PROMOTIONS/UPDATES signal). |

### Bulk unsubscribe (1, DESTRUCTIVE — `dry_run` + `confirm`)

| Name | Summary |
|---|---|
| `bulk_unsubscribe` | Parse List-Unsubscribe headers, hit URL/mailto (RFC 8058 one-click), optionally archive. |

### Drafts (5)

| Name | Type | Summary |
|---|---|---|
| `create_draft` | safe | Create a Gmail draft (does not send). |
| `list_drafts` | read | List Gmail drafts (slim shape). |
| `send_draft` | DESTRUCTIVE | Send an existing Gmail draft by ID. |
| `update_draft` | safe | Update an existing Gmail draft. |
| `delete_draft` | DESTRUCTIVE | Permanently delete a Gmail draft (NOT recoverable from Trash). |

All DESTRUCTIVE tools require `confirm: true`. Bulk modify + `bulk_unsubscribe` default to `dry_run: true` (returns a preview without applying); pass `dry_run: false` plus `confirm: true` to actually mutate.

`account` is required on every tool — no silent default. Mirrors the santo-agent hard rule.

## Setup

This MCP reuses the `~/.santo-agent/` OAuth token jar. **No `~/.config/smart-mcps/.env` entry is needed** — credentials live in `~/.santo-agent/oauth/<account>.json`.

### One-time bootstrap

For each Gmail account you want to use:

1. Drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json` (Google Cloud Console -> APIs & Services -> Credentials -> Desktop app) and enable the **Gmail API** on the project. See [docs/setup-google-oauth.md](../../docs/setup-google-oauth.md) for the full walkthrough.
2. Build the workspace and mint a token with the bundled CLI:
   ```bash
   npm install
   npm run build --workspace=email-smart
   node packages/email-smart/dist/bin/email-smart-auth.js <account-name>
   ```
   The CLI prints an authorization URL, spins up a localhost loopback HTTP server, waits for Google to redirect back with the code, exchanges it, and writes the token to `~/.santo-agent/oauth/<account-name>.json` (mode 0600). It requests `https://mail.google.com/`, `gmail.settings.basic`, and `gmail.settings.sharing` — the minimal set covering every shipped tool.
3. Drop an identity yaml at `~/.santo-agent/identities/<account-name>.yaml`:
   ```yaml
   account: <account-name>
   email: <name>@<domain>
   display_name: <Your name>
   default_reply_to: <name>@<domain>
   default_footer: <optional footer line>
   signature_html: |
     <strong>Your name</strong><br>
     ...
   signature_text: |
     Your name
     ...
   transport: oauth
   ```

### Install in MCP clients

```bash
npm install
npm run build
./scripts/install-clients.sh email-smart
```

Restart Claude Code / Cursor and run `/mcp`. `email-smart` should show 53 tools.

## Build & test

```bash
npm install
npm run build --workspace=email-smart
npm test --workspace=email-smart
```

## Notes

- **Multi-account by design.** Every tool requires `account: string`. Pass any configured account; the MCP loads its own OAuth token + identity yaml for that account.
- **Audit log shared with Python.** Both this MCP and `~/.santo-agent/bin/send-email.py` append to the same `~/.santo-agent/audit/send-log.jsonl`. Field order matches.
- **Permanent delete requires the full mail scope.** `delete_message_permanent`, `batch_delete_messages`, and `delete_thread_permanent` bypass Trash and cannot be undone; Gmail rejects them under `gmail.modify`, which is why `email-smart-auth` requests `https://mail.google.com/`. All three are hard-gated behind `confirm: true` (the batch tool additionally defaults to `dry_run: true`). Everything else that removes mail goes through Trash (auto-purges in 30 days; recoverable until then).
- **SMTP transport not yet supported.** If a Workspace EDU account (e.g. UTD) blocks third-party OAuth Desktop apps, `email-smart-auth` will fail at the consent screen. For those accounts you'd need an SMTP transport adapter (deferred to Phase 3.5).
- **Dry-run defaults on bulk modify.** Calling any of the four bulk modify tools without explicitly setting `dry_run: false` returns a preview only. This is the safest default for an LLM caller.
