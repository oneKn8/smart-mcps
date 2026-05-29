# slack-smart — design + executable plan

Date: 2026-05-29. Package: `packages/slack-smart`. Status: planned (not yet scaffolded).

This is the contract. Implementer subagents quote it verbatim. Code lives in source files, not here — this doc carries goals, verified API facts, conventions, and the task breakdown.

## Goal

A personal "smart" MCP for Slack, matching the rest of the `smart-mcps` fleet: raw Web API coverage plus opinionated composite tools (`catch_me_up`, `thread_catchup`, `smart_send`). Read your DMs/channels/threads, search, post/react/pin with confirm-gating, and get a one-call "what did I miss" digest.

Personal project. No former-employer references anywhere (code, commits, README, package scope) — same rule as the rest of this monorepo. No identity/email baked into code or docs; the operator supplies tokens via the shared `.env`.

## Acceptance criteria

1. `packages/slack-smart` builds clean (`tsc`), `npm test` green across the whole monorepo.
2. ~40 tools (35 raw + 5 smart composites) across the topic areas below, all `snake_case`, unique, terse descriptions.
3. Client validates Slack's HTTP-200 `{ok:false,error}` envelope and maps `error` codes to core error classes (net-new; no existing package does this).
4. Every write tool (`post_message`, `update_message`, `delete_message`, `schedule_message`, `add_reaction`, `remove_reaction`, `pin_message`, `unpin_message`, `set_snooze`, `end_snooze`, `upload_file`) is `guardDestructive`-gated with an accurate preview.
5. Token model: user token required (search + broad reads), bot token optional (post-as-bot); eager-fail at startup if the required token is missing.
6. Registered via `install-clients.sh` auto-discovery; appears in `/mcp` as `slack-smart`.
7. Full E2E verified against a dedicated dev workspace (separate checklist), including a write round-trip in a throwaway channel, before tagging.

## Non-goals (YAGNI)

- No Socket Mode / Events API / real-time subscriptions (this is a request/response tool surface).
- No interactive Block Kit builders, modals, slash-command handlers, or app-home.
- No admin.* / SCIM / enterprise-grid org methods.
- No OAuth callback server. Slack `xoxb`/`xoxp` tokens don't expire (no rotation), so tokens are pasted into the shared `.env` after a manual app install. A `slack-smart-auth` helper CLI is explicitly deferred.

## Architecture

Standard per-MCP layout (mirror `vercel-smart` for token auth, `email-smart` for breadth/confirm/smart-shortcut patterns):

```
src/
  client.ts            # SlackClient: loadCreds, token selection, slackCall() with {ok:false} unwrap + cursor pagination
  context.ts           # SlackContext { client: SlackClient }; buildContext() eager-fails on missing token
  server.ts            # createMcpServer<SlackContext>({ name: "slack-smart", ... })
  null-helpers.ts      # nullableString/Number/Boolean (verbatim from calendar-smart, comment reworded)
  channel-mapper.ts    # SlimChannel + mapChannel (reused across conversations + smart)
  message-mapper.ts    # SlimMessage + mapMessage (reused across history/replies/search/smart)
  user-mapper.ts       # SlimUser + mapUser (reused across users + smart)
  tools/
    identity.ts conversations.ts messages.ts search.ts reactions.ts
    users.ts files.ts pins.ts dnd.ts misc.ts smart.ts
    index.ts
  __tests__/{client,wire}.test.ts
  tools/__tests__/<topic>.test.ts
```

### Client design (the net-new parts)

- **Constructor**: optional `creds` param (tests), else `loadCreds<SlackCredsRecord>({ serviceName: "slack-smart", required: ["SLACK_USER_TOKEN"], optional: ["SLACK_BOT_TOKEN"] })`. Store `private readonly`. Same `Record<...>`-then-`as` cast wart as vercel.
- **`slackCall<T>(method, args, opts)`** private helper: builds `https://slack.com/api/<method>`, calls `fetchJson` with `token` (selected per `opts.token: "user" | "bot"`, default `"user"`) and JSON body (writes) or `searchParams` (reads). After `fetchJson` returns, validate `body.ok`:
  - `not_authed | invalid_auth | token_revoked | account_inactive | no_permission` → `AuthError` (name the env var).
  - `channel_not_found | user_not_found | message_not_found | thread_not_found | file_not_found` → `NotFoundError`.
  - `ratelimited` → `RateLimitError`.
  - else → `UpstreamError` with the `error` code.
  - `missing_scope` → `AuthError` whose message quotes `response.needed` (the scope to add).
- **Token selection rule**: `search.*` → user token (required by Slack). All reads default to user token (sees everything you can). `chat.postMessage`/`update`/`delete`/`scheduleMessage` accept an `as_user` flag → `false` (default) uses bot token (posts as the app; requires `SLACK_BOT_TOKEN`, else clear AuthError), `true` uses user token (posts as you). reactions/pins/dnd → user token. If a method needs the bot token and it's absent, throw `AuthError` naming `SLACK_BOT_TOKEN`.
- **Pagination helper**: reads expose `cursor` + `limit`; return upstream `response_metadata.next_cursor` as `next_cursor` in the slim output (conditional spread, omit when empty). Do not auto-paginate inside the client — one page per call, caller drives the cursor.
- **Rate limits**: HTTP-429 + `Retry-After` is already handled by core `fetchJson`. The `{ok:false, error:"ratelimited"}` body path maps to `RateLimitError` as above.

## Auth & scopes (operator setup — goes in README)

One Slack app created in the dedicated dev workspace, "Install to Workspace", then copy both tokens into `~/.config/smart-mcps/.env`:

```
SLACK_USER_TOKEN=xoxp-...   # required
SLACK_BOT_TOKEN=xoxb-...    # optional, enables post-as-bot
```

**User token scopes (xoxp):** `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `im:write`, `mpim:write`, `groups:write`, `users:read`, `users:read.email`, `users.profile:read`, `reactions:read`, `reactions:write`, `chat:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `dnd:read`, `dnd:write`, `usergroups:read`, `team:read`, `emoji:read`.

**Bot token scopes (xoxb, optional):** `chat:write`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:history`, `mpim:history`, `reactions:write`, `users:read`, `files:read`, `files:write`, `pins:read`, `pins:write`, `team:read`.

## Tool inventory (verified endpoints/scopes)

W = write (guardDestructive). Token = default token used.

| Tool | Slack method | Scope | Token | W |
|------|--------------|-------|-------|---|
| `whoami` | auth.test | — | user | |
| `list_channels` | conversations.list | channels:read(+groups/im/mpim:read) | user | |
| `channel_history` | conversations.history | channels:history(+variants) | user | |
| `thread_replies` | conversations.replies | channels:history(+variants) | user | |
| `channel_info` | conversations.info | channels:read(+variants) | user | |
| `channel_members` | conversations.members | channels:read(+variants) | user | |
| `open_dm` | conversations.open | im:write,mpim:write | user | |
| `post_message` | chat.postMessage | chat:write | bot/user* | W |
| `reply_in_thread` | chat.postMessage (thread_ts) | chat:write | bot/user* | W |
| `update_message` | chat.update | chat:write | bot/user* | W |
| `delete_message` | chat.delete | chat:write | bot/user* | W |
| `schedule_message` | chat.scheduleMessage | chat:write | bot/user* | W |
| `search_messages` | search.messages | search:read | user | |
| `search_files` | search.files | search:read | user | |
| `add_reaction` | reactions.add | reactions:write | user | W |
| `remove_reaction` | reactions.remove | reactions:write | user | W |
| `get_reactions` | reactions.get | reactions:read | user | |
| `list_users` | users.list | users:read,users:read.email | user | |
| `user_info` | users.info | users:read | user | |
| `user_profile` | users.profile.get | users.profile:read | user | |
| `lookup_by_email` | users.lookupByEmail | users:read.email | user | |
| `user_presence` | users.getPresence | users:read | user | |
| `resolve_user` | users.list + core `resolveOne` | users:read | user | |
| `list_files` | files.list | files:read | user | |
| `file_info` | files.info | files:read | user | |
| `upload_file` | getUploadURLExternal→POST→completeUploadExternal | files:write | user | W |
| `list_pins` | pins.list | pins:read | user | |
| `pin_message` | pins.add | pins:write | user | W |
| `unpin_message` | pins.remove | pins:write | user | W |
| `dnd_status` | dnd.info | dnd:read | user | |
| `set_snooze` | dnd.setSnooze | dnd:write | user | W |
| `end_snooze` | dnd.endSnooze | dnd:write | user | W |
| `list_usergroups` | usergroups.list | usergroups:read | user | |
| `team_info` | team.info | team:read | user | |
| `list_emoji` | emoji.list | emoji:read | user | |

*`post_message`/`reply_in_thread`/`update_message`/`delete_message`/`schedule_message`: `as_user` flag selects token (default bot).

### Smart composites (`tools/smart.ts`)

- **`catch_me_up`** (alias `daily_brief`) — orchestrate: `whoami` (resolve self id) → `list_channels(types: im,mpim)` for DMs → `channel_history` per DM (latest N) → `search_messages(query: "@<me>")` for mentions. Compose `{ dms: [...], mentions: [...], threads_active: [...], generated_at_hint }`. Honest `notes[]`, no fabricated counts. `since` arg (hours) windows the search.
- **`mentions`** — `search_messages` with the self-mention query; slim, sorted by timestamp.
- **`unread_digest`** — `list_channels(types: im,mpim)` + per-DM latest message; grouped slim view. (Slack's unread *counts* need `conversations.info` per channel; fetch `unread_count_display` where present, else report latest activity — document the limitation in `notes`.)
- **`thread_catchup`** — `conversations.replies(channel, ts)`, paginate to completion, return ordered clean `{ author, text, ts }[]` ready to summarize.
- **`smart_send`** — `resolveOne` channel (from `list_channels`) + optional `resolveOne` user; build a preview string (target + text); `guardDestructive`; then `chat.postMessage`. `as_user` flag respected.

## Error handling

All upstream failures surface as core error classes via the client's `{ok:false}` unwrap + `fetchJson`'s status mapping. `ConfirmRequiredError.preview` carries the human-readable action for write tools. `AmbiguousMatchError` from `resolveOne` surfaces candidate channels/users to the caller. Validation errors come from zod via `runToolSafely`.

## Test plan

Per monorepo TDD: red → green → refactor → atomic commit. `msw` `setupServer` for client tests (with the `HOME`-override `beforeEach` so `loadCreds` can't leak real creds); `vi.fn()` client stubs for tool tests. Mandatory net-new tests:

- Client: constructor eager-fails (AuthError) when `SLACK_USER_TOKEN` missing; **HTTP-200 `{ok:false,error}` body maps to the correct core error** for each branch (auth/notfound/ratelimited/upstream/missing_scope); token-selection picks user vs bot per method and errors clearly when bot token needed but absent; cursor pagination returns `next_cursor`.
- Tools: each write tool throws `ConfirmRequiredError` without `confirm:true` and performs the call with it; slim mappers strip upstream extras (sorted-keys assertion); smart composites compose from stubbed client calls.
- `wire.test.ts`: exact count, unique names, snake_case, unique terse descriptions.

## Task breakdown (sequential, atomic commit + reviewers per task)

Sequential to avoid `client.ts`/`tools/index.ts` merge conflicts (every topic touches both). Each task: fresh implementer subagent → spec-compliance review → code-quality review → fix Important flags → commit. Time is not a constraint.

1. **Scaffold + client core.** package.json (vercel-style deps, no `yaml`), tsconfig, vitest.config, `context.ts`, `server.ts`, `null-helpers.ts`, empty `tools/index.ts`, README stub, and `client.ts` with constructor + `slackCall()` ({ok:false} unwrap + token selection + pagination) + client core tests. Smoke: `SLACK_USER_TOKEN=test timeout 3 node dist/server.js < /dev/null` exits 0.
2. **identity** — `whoami`.
3. **conversations** (reads) — `list_channels`, `channel_history`, `thread_replies`, `channel_info`, `channel_members`, `open_dm` + `channel-mapper.ts`, `message-mapper.ts`.
4. **messages** (writes) — `post_message`, `reply_in_thread`, `update_message`, `delete_message`, `schedule_message`.
5. **search** — `search_messages`, `search_files`.
6. **reactions** — `add_reaction`, `remove_reaction`, `get_reactions`.
7. **users** — `list_users`, `user_info`, `user_profile`, `lookup_by_email`, `user_presence`, `resolve_user` + `user-mapper.ts`.
8. **files** — `list_files`, `file_info`, `upload_file` (3-step; raw POST step uses a dedicated upload method outside `slackCall`).
9. **pins** — `list_pins`, `pin_message`, `unpin_message`.
10. **dnd** — `dnd_status`, `set_snooze`, `end_snooze`.
11. **misc** — `list_usergroups`, `team_info`, `list_emoji`.
12. **smart** — `catch_me_up`/`daily_brief`, `mentions`, `unread_digest`, `thread_catchup`, `smart_send`.
13. **Finalize** — `wire.test.ts` final counts/names, full README (scopes + setup + tool list), `install-clients.sh` registration verified, `npm test` green monorepo-wide, smoke check.
14. **E2E** — separate checklist (below) against the dev workspace; settle tag name with operator, tag, push.

## E2E checklist (dedicated dev workspace)

Operator creates the app, installs it, adds `SLACK_USER_TOKEN`/`SLACK_BOT_TOKEN` to `~/.config/smart-mcps/.env`, creates a throwaway `#slack-smart-test` channel.

- Reads: `whoami`, `list_channels`, `channel_history` on a real channel, `search_messages`, `list_users`.
- Write round-trip in `#slack-smart-test`: `post_message` → `add_reaction` → `reply_in_thread` → `update_message` → `pin_message`/`unpin_message` → `delete_message`. Each first without `confirm` (expect preview), then with `confirm:true`.
- `upload_file` of a small text file to `#slack-smart-test`.
- `catch_me_up` end-to-end.
- Negative: bad token → AuthError naming the env var; missing scope → AuthError quoting `needed`.

## Open items to settle with operator

- Final tag name (avoid colliding with the in-flight, untracked `drive-smart`). Defaulting to `slack-smart-v1` precedent unless told otherwise.
- `upload_file` content source: local `file_path` (read bytes) vs inline `content_base64`. Plan supports `file_path` primary, `content_base64` optional.
