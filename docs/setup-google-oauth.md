# Google OAuth setup

This guide covers every Google-backed server in the monorepo:
`calendar-smart`, `tasks-smart`, `gdrive-smart`, `docs-smart`, `sheets-smart`,
`apps-script-smart`, `email-smart`, and `flow-smart`.

The model, end to end:

1. One Google Cloud project with the APIs you need enabled.
2. One OAuth client of type **Desktop app**, whose id/secret you drop at
   `~/.santo-agent/oauth/client.json`.
3. One token file per server per Google account, minted by that server's
   bundled auth CLI into `~/.santo-agent/oauth/`.
4. One `*_DEFAULT_IDENTITY` variable per server in
   `~/.config/smart-mcps/.env`, naming which account the server uses.

Do steps 1 and 2 once. Repeat steps 3 and 4 per server you enable.

## 1. Google Cloud project and APIs

Create (or reuse) a project at <https://console.cloud.google.com>. Under
**APIs & Services -> Library**, enable the API for each server you plan to
use:

| Server | Enable in the API Library |
|--------|---------------------------|
| `calendar-smart` | Google Calendar API |
| `tasks-smart` | Google Tasks API |
| `gdrive-smart` | Google Drive API |
| `docs-smart` | Google Docs API, Google Drive API |
| `sheets-smart` | Google Sheets API, Google Drive API |
| `apps-script-smart` | Apps Script API |
| `email-smart` | Gmail API |
| `flow-smart` | no extra API of its own; it reuses the tokens of the servers it composes (Gmail, Tasks, Calendar, Docs, Apps Script) |

`apps-script-smart` extra: the Apps Script management API also has to be
turned on for your *user*, not just the project. Visit
<https://script.google.com/home/usersettings> and switch "Google Apps Script
API" to On, or every project call fails with
`User has not enabled the Apps Script API`.

## 2. Consent screen and test user (the step everyone misses)

Under **APIs & Services -> OAuth consent screen** (newer console: **Google
Auth Platform -> Audience**):

- User type **External** is fine for a personal Gmail account.
- App name and contact email can be anything; nothing here is published.
- **Add your own Google account as a test user.** While the app is in
  "Testing" status, only listed test users can complete the OAuth flow.
  Skipping this is the single most common failure: the browser shows
  **"Error 403: access_denied"** (or "app has not completed the Google
  verification process") at sign-in time.
- Scopes do not need to be pre-declared on the consent screen for a Desktop
  client in testing mode; the auth CLIs request them directly.

Known limitation of Testing status: Google expires refresh tokens for
external testing apps after about 7 days. When that happens the servers start
failing with `refresh token revoked; re-run ...` and you must re-run the auth
CLI. If that gets old, move the app to "In production" on the same screen
(Google shows an unverified-app warning during consent, which you can click
through for your own app; personal use does not require verification).

## 3. OAuth client (Desktop app)

Under **APIs & Services -> Credentials -> Create credentials -> OAuth client
ID**, choose application type **Desktop app**. Download the JSON.

Place it at:

```
~/.santo-agent/oauth/client.json
```

```bash
mkdir -p ~/.santo-agent/oauth && chmod 700 ~/.santo-agent ~/.santo-agent/oauth
mv ~/Downloads/client_secret_*.json ~/.santo-agent/oauth/client.json
chmod 600 ~/.santo-agent/oauth/client.json
```

Both shapes are accepted: the raw Google download
(`{"installed": {"client_id": ..., "client_secret": ...}}`) or a flat
`{"client_id": ..., "client_secret": ...}`.

No redirect URIs need to be configured. Desktop-app clients allow loopback
redirects, and the auth CLIs bind a temporary HTTP server on
`http://127.0.0.1:<random port>` to catch the code.

## 4. Mint a token per server

Build the repo first (`npm install && npm run build`), then run the auth CLI
for each server, passing an account label of your choice (for example
`personal`). The label is just a file basename; use the same one everywhere
for the same Google account.

```bash
node packages/calendar-smart/dist/bin/calendar-smart-auth.js personal
node packages/tasks-smart/dist/bin/tasks-smart-auth.js personal
node packages/gdrive-smart/dist/bin/gdrive-smart-auth.js personal
node packages/docs-smart/dist/bin/docs-smart-auth.js personal
node packages/sheets-smart/dist/bin/sheets-smart-auth.js personal
node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js personal
```

Each CLI prints an authorization URL. Open it in a browser, sign in as the
test user, grant access, and the CLI finishes on its own once Google
redirects back to the loopback server. On success it prints the token path
and expiry.

Tokens land in `~/.santo-agent/oauth/` at mode 0600, one file per server so
scopes never mix:

| Server | Token file | Scopes requested |
|--------|-----------|------------------|
| `calendar-smart` | `<account>.calendar.json` | `auth/calendar` |
| `tasks-smart` | `<account>.tasks.json` | `auth/tasks` |
| `gdrive-smart` | `<account>.gdrive.json` | `auth/drive` |
| `docs-smart` | `<account>.docs.json` | `auth/documents`, `auth/drive.file` |
| `sheets-smart` | `<account>.sheets.json` | `auth/spreadsheets`, `auth/drive` |
| `apps-script-smart` | `<account>.script.json` | `auth/script.projects`, `.deployments`, `.processes`, `.metrics`, `.external_request` |
| `email-smart` | `<account>.json` | `auth/gmail.modify` (see below) |

Access tokens auto-refresh: each server refreshes against
`oauth2.googleapis.com/token` about a minute before expiry and rewrites its
token file, so a minted token keeps working until the refresh token itself is
revoked or expires.

## 5. Tell each server which account to use

Each Google server requires a `*_DEFAULT_IDENTITY` variable at startup, set
to the account label you used in step 4. Append to
`~/.config/smart-mcps/.env` (see the root README for creating that file):

```bash
CALENDAR_DEFAULT_IDENTITY=personal
TASKS_DEFAULT_IDENTITY=personal
GDRIVE_DEFAULT_IDENTITY=personal
DOCS_DEFAULT_IDENTITY=personal
SHEETS_DEFAULT_IDENTITY=personal
APPS_SCRIPT_DEFAULT_IDENTITY=personal
FLOW_DEFAULT_IDENTITY=personal
```

Only add the lines for servers you actually registered. `email-smart` does
not use a `*_DEFAULT_IDENTITY` variable; every tool call passes an explicit
`account` argument instead.

## email-smart: two extra pieces

`email-smart` predates the bundled auth CLIs and reads a token file with no
server suffix: `~/.santo-agent/oauth/<account>.json`, with the
`https://www.googleapis.com/auth/gmail.modify` scope. Its error messages
reference `python3 ~/.santo-agent/bin/auth.py`, a bootstrap script from the
author's machine that is **not part of this repo**. Until an `email-smart-auth`
CLI ships, mint the file yourself: any OAuth flow for your Desktop client
requesting `gmail.modify` works, and the file must be JSON of exactly this
shape (Google's authorized_user format plus `expiry`):

```json
{
  "token": "<access token>",
  "refresh_token": "<refresh token>",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "<from client.json>",
  "client_secret": "<from client.json>",
  "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
  "expiry": "<ISO-8601 timestamp>"
}
```

The bundled CLIs write exactly this shape, so adapting one is
straightforward; the file is validated field-by-field at load time and any
missing field produces an `AuthError` naming it.

`email-smart` also requires an identity file per account at
`~/.santo-agent/identities/<account>.yaml`:

```yaml
account: personal
email: you@example.com
display_name: Your Name
transport: oauth
```

(`default_reply_to`, `default_footer`, `signature_html`, `signature_text` are
optional.)

## Errors you will actually see

Startup, missing identity variable (server exits immediately; your MCP
client shows the server as failed):

```
AuthError: Missing required credentials for calendar-smart: CALENDAR_DEFAULT_IDENTITY
```

Fix: step 5. The error's recovery text lists every file path that was
searched.

First tool call, token never minted:

```
AuthError: token at /home/you/.santo-agent/oauth/personal.calendar.json not found; run node packages/calendar-smart/dist/bin/calendar-smart-auth.js personal
```

Fix: step 4.

Browser during consent, `Error 403: access_denied`: you are not listed as a
test user, or you signed into a different Google account than the one listed.
Fix: step 2.

Auth CLI, `Token exchange response invalid: missing refresh_token`: Google
only issues a refresh token on the first consent. Revoke the app at
<https://myaccount.google.com/permissions> and re-run the CLI.

Tool call, `refresh token revoked; re-run ...`: the refresh token expired
(7-day testing-mode limit) or was revoked. Re-run the server's auth CLI.

`User has not enabled the Apps Script API`: per-user toggle at
<https://script.google.com/home/usersettings>, see step 1.

403 mentioning re-consent with additional scopes: the token file predates a
scope the server now needs; re-run that server's auth CLI to mint a fresh
token.
