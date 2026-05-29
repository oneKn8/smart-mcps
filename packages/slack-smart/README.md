# slack-smart

MCP server for Slack: read channels, DMs and threads; search messages and files; post, react, pin and manage Do Not Disturb — all with confirm-gated writes and smart composite shortcuts for daily catch-up. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app ("From scratch"). Give it any name and select your workspace.

### 2. Add OAuth scopes

Under **OAuth & Permissions**, add the following scopes:

**User token scopes (xoxp) — required:**

`search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `im:write`, `mpim:write`, `groups:write`, `users:read`, `users:read.email`, `users.profile:read`, `reactions:read`, `reactions:write`, `chat:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `dnd:read`, `dnd:write`, `usergroups:read`, `team:read`, `emoji:read`

**Bot token scopes (xoxb) — optional, enables post-as-bot:**

`chat:write`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:history`, `mpim:history`, `reactions:write`, `users:read`, `files:read`, `files:write`, `pins:read`, `pins:write`, `team:read`

### 3. Install to workspace

Click **Install to Workspace** and authorize. Copy both tokens:

- **User OAuth Token** (`xoxp-...`) — required for all reads and search
- **Bot User OAuth Token** (`xoxb-...`) — optional, required only if you want to post as the bot app

### 4. Add tokens to the shared env file

```bash
# ~/.config/smart-mcps/.env  (chmod 600)
SLACK_USER_TOKEN=xoxp-...   # required
SLACK_BOT_TOKEN=xoxb-...    # optional — enables post-as-bot
```

`SLACK_USER_TOKEN` is required. The server exits at startup if it is missing. `search.*` tools always use the user token (Slack does not allow bot tokens for search).

## Registration

Build and register with the multi-client installer from the repo root:

```bash
npm install
npm run build
./scripts/install-clients.sh slack-smart
```

The installer auto-discovers `packages/*/dist/server.js` and registers `slack-smart` in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and prints a Codex snippet. After registration, restart your MCP client. Tools appear under the `slack-smart` namespace.

## Tools (40)

Write tools are confirm-gated: they throw a `ConfirmRequiredError` with a human-readable preview unless `confirm: true` is passed. This prevents accidental writes.

### Identity (1)

| Name | Description |
|---|---|
| `whoami` | Return the authenticated user's id, name, and team info. |

### Conversations (6, read-only)

| Name | Description |
|---|---|
| `list_channels` | List channels, DMs, and group DMs the user can access. |
| `channel_history` | Fetch recent messages from a channel or DM. |
| `thread_replies` | Fetch all replies in a message thread. |
| `channel_info` | Get metadata for a single channel by ID. |
| `channel_members` | List members of a channel. |
| `open_dm` | Open a DM or group DM and return the conversation ID. |

### Messages (5, write — confirm-gated)

| Name | Description |
|---|---|
| `post_message` | Post a message to a channel or DM. |
| `reply_in_thread` | Reply to an existing thread in a channel. |
| `update_message` | Edit the text of an existing message. |
| `delete_message` | Delete a message by channel and timestamp. |
| `schedule_message` | Schedule a message to be sent at a future unix timestamp. |

### Search (2, read-only)

| Name | Description |
|---|---|
| `search_messages` | Full-text search across messages (user token, scope search:read). |
| `search_files` | Full-text search across files (user token, scope search:read). |

### Reactions (3)

| Name | Description |
|---|---|
| `add_reaction` | Add an emoji reaction to a message (write — confirm-gated). |
| `remove_reaction` | Remove an emoji reaction from a message (write — confirm-gated). |
| `get_reactions` | Get all reactions on a message. |

### Users (6, read-only)

| Name | Description |
|---|---|
| `list_users` | List all users in the workspace. |
| `user_info` | Get basic info for a user by ID. |
| `user_profile` | Get the full profile for a user by ID. |
| `lookup_by_email` | Find a user by email address. |
| `user_presence` | Get the presence status of a user. |
| `resolve_user` | Resolve a display name or real name to a user ID. |

### Files (3)

| Name | Description |
|---|---|
| `list_files` | List files visible to the user token. |
| `file_info` | Get metadata for a single file by ID. |
| `upload_file` | Upload a file to Slack via the 3-step external upload flow (write — confirm-gated). |

### Pins (3)

| Name | Description |
|---|---|
| `list_pins` | List pinned items in a channel. |
| `pin_message` | Pin a message in a channel (write — confirm-gated). |
| `unpin_message` | Unpin a message from a channel (write — confirm-gated). |

### Do Not Disturb (3)

| Name | Description |
|---|---|
| `dnd_status` | Get the DND / snooze status for a user. |
| `set_snooze` | Enable DND snooze for a given number of minutes (write — confirm-gated). |
| `end_snooze` | End an active DND snooze immediately (write — confirm-gated). |

### Misc (3, read-only)

| Name | Description |
|---|---|
| `list_usergroups` | List user groups in the workspace. |
| `team_info` | Get basic info about the workspace. |
| `list_emoji` | List custom emoji in the workspace. |

### Smart composites (5)

| Name | Description |
|---|---|
| `catch_me_up` | Summarize recent DM activity and @mentions since a given lookback window. |
| `mentions` | Fetch recent messages that mention the authenticated user. |
| `unread_digest` | Show latest activity across DMs and group DMs. |
| `thread_catchup` | Fetch all replies in a thread, ordered for easy reading. |
| `smart_send` | Resolve a channel or user by name and post a message with a confirm preview. |

## Safety

Write tools (`post_message`, `reply_in_thread`, `update_message`, `delete_message`, `schedule_message`, `add_reaction`, `remove_reaction`, `upload_file`, `pin_message`, `unpin_message`, `set_snooze`, `end_snooze`, `smart_send`) all call `guardDestructive` before touching the API. Without `confirm: true` they return a preview of the action and throw `ConfirmRequiredError`. Pass `confirm: true` to execute.

Read tools default to the user token (`xoxp`). `post_message`, `reply_in_thread`, `update_message`, `delete_message`, and `schedule_message` accept a `send_as` field: `"bot"` (default) uses `SLACK_BOT_TOKEN`; `"user"` uses `SLACK_USER_TOKEN`.

## Build and test

From repo root:

```bash
npm install
npm run build --workspace=slack-smart
npm test --workspace=slack-smart
```

Smoke test (requires `SLACK_USER_TOKEN` to be set):

```bash
SLACK_USER_TOKEN=xoxp-test timeout 3 node packages/slack-smart/dist/server.js < /dev/null
```

The server runs over stdio and waits for MCP protocol messages. With `</dev/null` it boots, finds no input, and exits cleanly.
