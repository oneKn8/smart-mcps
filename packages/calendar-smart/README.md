# calendar-smart

Personal Google Calendar MCP — full coverage of Google Calendar API v3. Read agenda, find availability, create / update / cancel events, manage recurring series, search + sync, calendar CRUD, sharing, settings, colors, group free/busy. Single account. Reuses the `~/.santo-agent/oauth/` token jar pattern with a separate `<account>.calendar.json` token slot. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

Scope: `https://www.googleapis.com/auth/calendar` (full read + write on every calendar the bound user has access to).

## Tools (44)

### Read agenda (5)

| Name | Summary | Notes |
|---|---|---|
| `list_events` | List events in a window with optional query. | `{ calendar_id?, time_min?, time_max?, query?, max_results?, page_token?, event_types?, private_extended_property?, show_deleted? }` |
| `get_event` | Get a single event by id. | `{ event_id, calendar_id? }` |
| `daily_agenda` | Events for a single day. | `{ date?, calendar_id? }` (date defaults to today in the calendar tz) |
| `weekly_agenda` | Events for a Mon-Sun week. | `{ week_of?, calendar_id? }` |
| `next_event` | Next upcoming event. | `{ within_hours?, calendar_id? }` (default 24h, max 720h) |

### Availability (3)

| Name | Summary |
|---|---|
| `find_availability` | Find free blocks of N minutes inside a window. |
| `busy_blocks` | List busy windows across one or more calendars. |
| `conflicts_check` | Find events overlapping a proposed window (half-open; adjacent does not count). |

### Create / modify (6)

| Name | Type | Summary |
|---|---|---|
| `quick_add` | safe | Create event from natural-language text (Google's NLP). |
| `create_event` | safe | Create a structured event with full field support. |
| `update_event` | safe | Patch an event by id. Series id touches the whole series. |
| `reschedule` | safe | Time-only update sugar (`event_id, start, end`). |
| `cancel_event` | DESTRUCTIVE | Delete an event by id (`confirm: true` required). |
| `respond_to_event` | safe | Set RSVP on an event you're invited to. |

`create_event` / `update_event` accept the full Calendar v3 event surface: `summary, start, end, attendees, location, description, recurrence, reminders, create_meet_link, color_id, visibility, transparency, guests_can_invite_others, guests_can_modify, guests_can_see_other_guests, source, extended_properties, send_updates, event_type` (`default | outOfOffice | focusTime | workingLocation | birthday`), plus the per-type property bags (`focus_time`, `out_of_office`, `working_location`, `birthday`). All-day events: pass `start` / `end` as bare `YYYY-MM-DD`. `attendees` accepts either `string[]` (emails) or `{ email, optional?, response?, resource? }[]`.

### Recurring series (4)

| Name | Type | Summary |
|---|---|---|
| `list_instances` | safe | Expand a recurring series into its actual occurrences. |
| `update_instance` | safe | Update one occurrence (instance id) without touching the series. |
| `cancel_instance` | DESTRUCTIVE | Skip one occurrence (`PATCH status:"cancelled"`, `confirm: true`). |
| `split_recurrence` | DESTRUCTIVE | "This and following": cap series with `UNTIL=`, then create a new series. `confirm: true`. |

### Search + sync (2)

| Name | Summary |
|---|---|
| `search_events` | Full-text + filter search (`query`, `event_types`, `private_extended_property`). |
| `sync_events` | Incremental delta fetch via `syncToken`. Returns `full_resync_required: true` on 410. |

### Calendar management (4)

| Name | Type | Summary |
|---|---|---|
| `list_calendars` | safe | List calendars (`show_hidden`, `show_deleted`, `min_access_role` filters). |
| `get_calendar` | safe | Get one calendar (slim shape from CalendarList). |
| `get_calendar_metadata` | safe | Get the bare Calendar resource (`conferenceProperties`, etc.). |
| `move_event` | safe | Move event to another calendar (organizer must own destination). |

### Calendar CRUD (4)

| Name | Type | Summary |
|---|---|---|
| `create_calendar` | safe | Create a new secondary calendar. |
| `update_calendar` | safe | Update calendar metadata (`summary`, `description`, `location`, `time_zone`). |
| `delete_calendar` | DESTRUCTIVE | Delete a secondary calendar (`confirm: true`; refuses primary). |
| `clear_primary_calendar` | DESTRUCTIVE | Wipe ALL events from primary (calendar metadata preserved). NUKE option. |

### Subscriptions (CalendarList) (3)

| Name | Type | Summary |
|---|---|---|
| `subscribe_calendar` | safe | Add an existing calendar (someone else's) to your sidebar by id. |
| `unsubscribe_calendar` | DESTRUCTIVE | Remove a calendar from sidebar (refuses primary; `confirm: true`). |
| `update_calendar_subscription` | safe | Change color, label, default reminders, notification settings on a subscription. |

### Sharing (ACL) (4)

| Name | Type | Summary |
|---|---|---|
| `list_calendar_shares` | safe | List who has access to a calendar. |
| `share_calendar` | DESTRUCTIVE | Grant access (`role`, `scope_type`, `scope_value`; `confirm: true`). |
| `update_calendar_share` | DESTRUCTIVE | Change someone's role (`confirm: true`). |
| `revoke_calendar_share` | DESTRUCTIVE | Remove a share rule (`confirm: true`). |

### Settings + colors (3)

| Name | Summary |
|---|---|
| `list_user_settings` | All user calendar preferences as a flat record. |
| `get_user_setting` | One specific setting (`timezone`, `weekStart`, `defaultEventLength`, etc.). |
| `get_colors` | Event + calendar color palettes (id → `{background, foreground}` hex). |

### Group free/busy (1)

| Name | Summary |
|---|---|
| `freebusy_group` | Query a Google Group's calendar (expands to members; per-member busy + per-member errors). |

### Smart shortcuts (5)

| Name | Summary |
|---|---|
| `daily_brief` | Today: total + first 3 events + first overlap pair + biggest free block. |
| `weekly_brief` | Week: total + busiest day + per-day counts + biggest free block. |
| `find_meeting_time` | Combine `freeBusy` over `my_calendar_ids` + raw `extra_busy`; top N earliest slots ≥ duration. |
| `event_with_invite_preview` | Pure preview: `create_event` payload + invite-email subject + body. NO side effects. |
| `outdoor_event_check` | Surface event location + hint pointing at `weather-smart.outdoor_window`. |

All read tools are safe to call freely. Destructive tools require `confirm: true` and surface a preview through `ConfirmRequiredError`.

## Setup

Calendar-smart reuses the `~/.santo-agent/` OAuth token jar pattern but writes to a dedicated `<account>.calendar.json` slot so the token is independent from `email-smart`'s `<account>.json`.

### One-time bootstrap

1. Drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json` (Google Cloud Console → APIs & Services → Credentials → Desktop app). Enable the **Google Calendar API** on the project: `https://console.developers.google.com/apis/library/calendar-json.googleapis.com`.
2. Build the workspace:
   ```bash
   npm install
   npm run build --workspace=calendar-smart
   ```
3. Mint a calendar token (default account: `your-account`):
   ```bash
   node packages/calendar-smart/dist/bin/calendar-smart-auth.js your-account
   ```
   The CLI prints an authorization URL, spins up a localhost loopback HTTP server, waits for Google to redirect back with the code, exchanges it, and writes the token to `~/.santo-agent/oauth/your-account.calendar.json` (mode 600). Loopback (not OOB) — Google deprecated `urn:ietf:wg:oauth:2.0:oob` in October 2022.
4. Register the MCP in clients:
   ```bash
   ./scripts/install-clients.sh calendar-smart
   ```
5. Restart Claude Code / Cursor and run `/mcp`. `calendar-smart` should show **44 tools**.

### Build & test

```bash
npm install
npm run build --workspace=calendar-smart
npm test --workspace=calendar-smart
```

Smoke test (boots stdio, AuthError on first tool call if the token is missing):

```bash
timeout 3 node packages/calendar-smart/dist/server.js < /dev/null
```

Live smoke (against real Google Calendar API; requires the calendar token):

```bash
node packages/calendar-smart/scripts/live-smoke.mjs your-account
```

## Credentials

Optional default-identity override in `~/.config/smart-mcps/.env`:

```bash
# --- calendar-smart ---
# CALENDAR_DEFAULT_IDENTITY=your-account
```

When unset the MCP defaults to `your-account`. Multi-account is on the deferred list.

The token itself never lives in `.env` — it's at `~/.santo-agent/oauth/<account>.calendar.json` (mode 600).

## Composition

Calendar-smart never imports `email-smart` or `weather-smart`. Cross-MCP composition happens at the LLM caller layer:

- **Schedule + send invite.** `event_with_invite_preview` → confirm payload + body → `create_event` → `email-smart.send_email`.
- **Outdoor event forecast.** `outdoor_event_check` → surfaced `location` → `weather-smart.geocode` → `weather-smart.outdoor_window` at event start.
- **Auto Meet link.** `create_event({ create_meet_link: true })` — sets `conferenceData.createRequest`, Google generates a Meet URL, `event.meeting_url` is mapped on the read side.

## Time zones

The first tool call resolves the primary calendar's time zone via `GET /users/me/calendarList/primary` and caches it on the client. All agenda + availability + brief tools render windows in the cached zone (so `daily_agenda({})` means midnight-to-midnight in your local calendar tz, not UTC). Verified for `America/Chicago` (DST spring-forward + fall-back) and `Asia/Dhaka` (UTC+06, no DST).

## Recurring event semantics

- `update_event` / `cancel_event` on a series id touches the entire series.
- `update_instance` / `cancel_instance` take an instance id (`<event_id>_<YYYYMMDDTHHMMSSZ>`) and modify only that occurrence.
- `split_recurrence` implements "this and following" via the documented two-call dance: PATCH master `recurrence` to add `UNTIL=<targetStart - 1s in UTC>`, then `events.insert` a new series at `target_start` with the new fields.
- `list_instances` expands a series into its concrete occurrences for inspection.

## Sync semantics

`sync_events` returns `next_sync_token`. Pass it back on the next call to get only deltas. On 410 Gone (~30 days idle, or after some param changes), the response sets `full_resync_required: true` and the caller restarts without `sync_token`.

## Sharing (ACL)

`scope.type = "default"` means the rule applies to anyone with the link (public). For `user`, `group`, or `domain`, pass the corresponding `scope_value` (email or domain). `share_calendar` defaults `send_notifications: true` — the recipient gets an email.

## Out of scope (deliberate deferrals)

- **Push notifications** (`*.watch` + `channels.stop`). Needs a public HTTPS webhook endpoint with valid CA cert, no auto-renew, notifications carry no body. `sync_events` covers 95% of the polling use case without the webhook infrastructure.
- **`events.import`**. Useful only for migrating from another system with stable iCalUIDs; add when a real migration appears.
- **Multi-account.** `CALENDAR_DEFAULT_IDENTITY` exists but only one account is wired. Pattern from email-smart can be lifted later.
- **Drive attachments on insert.** `attachments[]` field requires a Drive scope bump; defer until needed.
- **Workspace-only fields**: `workingLocationProperties.officeLocation` building/floor/desk IDs (admin directory data needed); resource calendar `autoAcceptInvitations`.
- **Conference solutions other than Google Meet.** Zoom etc. require Workspace add-on plumbing.
- **Auto-pagination.** `pageToken` plumbing exists; no auto-loop. Caller drives multi-page reads.
- **Deprecated fields.** `gadget.*`, `alwaysIncludeEmail` query param.
