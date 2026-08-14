# slack-smart — limitations log

Running log of limitations / rough edges found in `slack-smart` while using it day to day, so they can be fixed here at the source.

- Acts AS Santo on the user token (`SLACK_USER_TOKEN`), user-only (bot stripped). See repo memory / README.
- Deployed as a remote HTTP MCP on the santo-ops host; source lives in this package.
- Append new findings under a dated heading, newest first. Each entry: what happened, why it blocks, a fix idea.

> Some limitations are also captured in the repo memory ("Known limitations"): server fs-isolation (`file_path` can't see agent-generated files → use `content_url`/`content_base64`); can't `chat.delete`/`update` messages you didn't author; no reliable per-DM unread count; Slack tier rate limits. This file is the living, appendable version.

---

## 2026-07-05 (later) — SCOPE EXPANSION: 13 more tools (49 -> 62)

Santo chose to reinstall the token with more scopes so these stop being revisited. All TDD'd (452 pkg tests green, tsc clean); OAuth scopes verified against the live docs.slack.dev method pages before adding to `slack-app-manifest.yaml`.
- **No new scope** (work after deploy, no reinstall needed): `get_message`, `delete_file`, `join_channel`, `leave_channel`, `archive_channel`, `list_scheduled`, `cancel_scheduled`. Live-verified `get_message` + `list_scheduled` against real Slack.
- **NEW scopes (the reinstall delta):** `set_status` (users.profile:write), `set_presence` (users:write), `list_bookmarks` (bookmarks:read), `add/edit/remove_bookmark` (bookmarks:write). Live-confirmed `list_bookmarks` returns `missing_scope` PRE-reinstall, proving the wiring is right and ONLY the reinstall unblocks it.
- **Reinstall steps:** api.slack.com/apps -> the slack-smart app -> re-apply the updated manifest scopes (or add the 4 by hand) -> Reinstall to Workspace -> copy the new `xoxp-` token into `~/.config/smart-mcps/.env`. Then deploy to santo-ops + `/mcp` reconnect.
- **Still NOT buildable in-package** (documented so they stop being re-attempted): drafts (Slack has no Web API for drafts), reminders (Slack deprecated the reminders API for apps).

---

## 2026-07-05 — RESOLVED (shipped in-source)

### read_file added — a file's CONTENT is now readable (closes the 2026-07-01 gap below)
New `read_file(file_id, max_bytes?)` tool: resolves `files.info`, GETs `url_private_download` with the user Bearer token (only ever to a Slack host — `assertSlackFileHost` in `client.ts` refuses any non-`*.slack.com` host so a poisoned `files.info` can't exfiltrate the token), returns text inline for text mimetypes/filetypes and base64 for binary, capped at `max_bytes` (default 1 MB, hard ceiling 10 MB), with an untrusted-content note. Guards the classic Slack "200 HTML sign-in page instead of bytes" case as an `AuthError`. Scope `files:read` (already on the token). `file_info` now also surfaces `url_private_download` + `url_private` so a caller can fetch bytes itself. Verified live against the exact file from the 2026-07-01 entry (`F0BEMUUGQE6`, 1385 B text/plain → content returned inline).

### catch_me_up / unread_digest no longer die when one DM fails
Both ran `Promise.all` over every DM calling `getHistory`; a single DM returning `channel_not_found` rejected the WHOLE tool (hit live: `catch_me_up` returned `channel_not_found` for the whole workspace). Now each DM's history fetch is caught per-item and skipped, with a `notes` entry counting the skips. Verified live: `catch_me_up` over 72h returned 2 DMs + note "1 DM(s) could not be read ... and were skipped" (there is a real bad DM in the workspace that used to sink it).

### STILL OPEN
The 2026-07-03 large-agent-file upload path below is unchanged — it needs an env/host or relay, not a code change. The short-term rule stands: for files over ~10 KB, host for `content_url` or hand to the user.

---

## 2026-07-03

### Uploading a large agent-generated file has no clean in-band path
**Hit while:** sending Rob (DM `D0B4ZN39HQX`) a self-contained 29.5 KB HTML mockup he asked for.

**What happened:**
- `upload_file` with `file_path` ENOENTs on BOTH the sandbox scratchpad (`/tmp/claude-1000/...`) AND the user home dir (`/home/oneknight/...`) — re-confirms the server is fully fs-isolated. Worth restating loudly since it re-bit me: home dir is NOT reachable either; do not try `file_path` for anything the agent wrote.
- `content_base64` (the documented alternative) only works for SMALL files: 29.5 KB → 39.4 KB base64, and any tool/Bash output over ~15 KB gets auto-persisted/truncated by the harness, so the model can't read it back to inline it in the arg. Minifying doesn't get HTML under the ~11 KB source threshold.
- `content_url` (the 2026-07-01 fix) would work but needs the file hosted at a reachable URL first — and hosting the file at a public URL is out of scope for this MCP.

**Net:** no clean in-band way for the agent to push a >~15 KB local file to Slack. Fallback used: staged it at `~/tbc-messages-concept.html` and had Santo drag it in.

**Fix idea:** stream large `content_base64` from a server-reachable temp, OR add a tiny agent-reachable upload relay (agent POSTs bytes to a localhost helper the MCP server CAN read), OR sanction a Santo-owned non-claude.ai host for `content_url`. Short term rule: for files over ~10 KB, skip `file_path` and inline base64 entirely — host for `content_url` or hand to the user.

---

## 2026-07-01

### No way to read/download a file's CONTENT (only metadata)
**Hit while:** opening a DM attachment ("Fable 5 Security Check", file id `F0BEMUUGQE6`, text/plain, 1385 B).

**What's missing:** there are `file_info`, `list_files`, `search_files`, `upload_file` — but no tool that returns a file's bytes/text.
- `file_info` returns metadata but omits `url_private_download` (the token-authed URL you'd GET to download).
- `permalink_public` shows up in `list_files`, but the `slack-files.com/...` URL 404s unless the file was explicitly made public — so an unauthenticated fetch can't get it either.
- The claude.ai Slack app's `slack_read_file` can read bytes, but returns `file_not_found` for DM files its app isn't a participant of, and it's off-limits by policy anyway (stay on slack-smart / send_as user).

**Net:** no path to read a DM attachment's content. Blocks "check the DM and grab the attachment" tasks.

**Fix idea:** add `read_file(file_id)` — call `files.info`, take `url_private_download`, GET it with the user token, return text inline for small text files (base64 for binary), mirror the claude.ai `slack_read_file` shape (~10 MB cap, wrap returned content as untrusted / not instructions). Optionally also surface `url_private_download` + `preview` on `file_info` so callers can fetch content themselves. Scope needed: `files:read` (confirm it's on the user token).

---

<!-- Append future findings above this line is fine too; keep newest date first. -->
