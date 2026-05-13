# calendar-smart

Personal Google Calendar MCP — read agenda, find availability, create / update / cancel events, plus smart-shortcut composition with `email-smart` and `weather-smart`. Single account; reuses the `~/.santo-agent/oauth/` token jar pattern with a separate `<account>.calendar.json` token slot. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

Scope: `https://www.googleapis.com/auth/calendar` (full read + write on every calendar the bound user has access to).

## Tools (21)

### Read agenda (5, read-only)

| Name | Summary | Notes |
|---|---|---|
| `list_events` | List events in a window with optional query. | `{ calendar_id?, time_min?, time_max?, query?, max_results?, page_token? }` |
| `get_event` | Get a single event by id. | `{ event_id, calendar_id? }` |
| `daily_agenda` | Events for a single day. | `{ date?, calendar_id? }` (date defaults to today in the calendar tz) |
| `weekly_agenda` | Events for a Mon-Sun week. | `{ week_of?, calendar_id? }` |
| `next_event` | Next upcoming event. | `{ within_hours?, calendar_id? }` (default 24h, max 720h) |

### Availability (3, read-only)

| Name | Summary | Notes |
|---|---|---|
| `find_availability` | Find free blocks of N minutes. | `{ duration_minutes, time_min, time_max, calendar_id? }` |
| `busy_blocks` | List busy windows across calendars. | `{ time_min, time_max, calendar_ids? }` |
| `conflicts_check` | Find events overlapping a window. | `{ start, end, calendar_id? }` (half-open: adjacent does NOT count) |

### Create / modify (6)

| Name | Type | Summary | Notes |
|---|---|---|---|
| `quick_add` | safe | Create event from natural-language text. | Wraps Google's `events.quickAdd` NLP. |
| `create_event` | safe | Create a structured event. | `{ summary, start, end, attendees?, location?, description?, recurrence?, calendar_id? }` |
| `update_event` | safe | Patch an event by id. | Partial update. Recurring series updates the entire series unless an instance id is passed. |
| `reschedule` | safe | Time-only update sugar. | `{ event_id, start, end, calendar_id? }` |
| `cancel_event` | DESTRUCTIVE | Delete an event by id. | Requires `confirm: true`; preview surfaces summary + start + attendee count. |
| `respond_to_event` | safe | Set RSVP on an event you're invited to. | `{ event_id, response: "accepted"\|"declined"\|"tentative", calendar_id? }` |

`update_event` / `reschedule` / `create_event` / `quick_add` are NOT confirm-gated: creates are reversible by `cancel_event`, updates by re-running with prior values.

### Calendar management (2, read-only)

| Name | Summary |
|---|---|
| `list_calendars` | List every calendar on the user's calendar list. |
| `get_calendar` | Get one calendar (slim shape with `accessRole`, `primary`, `time_zone`). |

### Smart shortcuts (5, read-only)

| Name | Summary | Notes |
|---|---|---|
| `daily_brief` | Today: events, conflict, biggest gap. | Total count + first 3 events + first overlap pair + biggest free block. |
| `weekly_brief` | Week: total, busiest day, biggest gap. | Per-day counts (7 entries Mon-Sun), busiest day (ties broken by earliest), biggest free block across the week. |
| `find_meeting_time` | Find best meeting times. | Combines `freeBusy` queries on `my_calendar_ids` with raw `extra_busy` windows; returns top N earliest slots ≥ duration. |
| `event_with_invite_preview` | Preview event + invite email. | Pure preview: emits a `create_event` payload + an invite-email subject and body. NO side effects. |
| `outdoor_event_check` | Surface event location for weather check. | Returns event + location + a hint pointing at `weather-smart.geocode` and `weather-smart.outdoor_window`. |

All read-only tools are safe to call freely. Only `cancel_event` requires `confirm: true`.

## Setup

Calendar-smart reuses the `~/.santo-agent/` OAuth token jar pattern but writes to a dedicated `<account>.calendar.json` slot so the token is independent from `email-smart`'s `<account>.json`.

### One-time bootstrap

1. Drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json` (Google Cloud Console → APIs & Services → Credentials → Desktop app). The Calendar API scope (`https://www.googleapis.com/auth/calendar`) must be added on the OAuth consent screen.
2. Build the workspace:
   ```bash
   npm install
   npm run build --workspace=calendar-smart
   ```
3. Mint a calendar token for your account (default account: `your-account`):
   ```bash
   node packages/calendar-smart/dist/bin/calendar-smart-auth.js your-account
   ```
   The CLI prints an authorization URL; sign in, paste the resulting code back, and the token saves to `~/.santo-agent/oauth/your-account.calendar.json` (mode 600).
4. Register the MCP in clients:
   ```bash
   ./scripts/install-clients.sh calendar-smart
   ```
5. Restart Claude Code / Cursor and run `/mcp`. `calendar-smart` should show 21 tools.

### Build & test

```bash
npm install
npm run build --workspace=calendar-smart
npm test --workspace=calendar-smart
```

Smoke test (boots stdio, throws `AuthError` on first tool call if the token is missing):

```bash
timeout 3 node packages/calendar-smart/dist/server.js < /dev/null
```

Exit code 124 (timeout) means the server boots cleanly and waits for MCP messages on stdio.

## Credentials

Optional default-identity override in `~/.config/smart-mcps/.env`:

```bash
# --- calendar-smart ---
# CALENDAR_DEFAULT_IDENTITY=your-account
```

When unset the MCP defaults to `your-account`. Multi-account is on the Phase 5.5 backlog.

The token itself never lives in `.env` — it's at `~/.santo-agent/oauth/<account>.calendar.json` (mode 600).

## Composition

Calendar-smart is intentionally narrow: it never imports `email-smart` or `weather-smart`. Cross-MCP composition happens at the LLM caller layer:

- **Schedule + send invite.** Call `event_with_invite_preview` → confirm the payload + body → call `create_event` → call `email-smart.send_email` with the surfaced subject + body.
- **Outdoor event forecast.** Call `outdoor_event_check` → take the surfaced `location` → call `weather-smart.geocode` → `weather-smart.outdoor_window` for that lat/lng at the event's start time.

This keeps each MCP focused on its own API and avoids dependency tangles. The LLM does the orchestration.

## Time zones

The first tool call resolves the primary calendar's time zone via `GET /users/me/calendarList/primary` and caches it on the client for the rest of the process lifetime. All agenda + availability + brief tools render windows in the cached zone (so `daily_agenda({})` means midnight-to-midnight in your local calendar tz, not UTC). Verified for `America/Chicago` (DST spring-forward + fall-back) and `Asia/Dhaka` (UTC+06, no DST).

## Notes

- **Single-account.** `CALENDAR_DEFAULT_IDENTITY` exists but only one account is wired. Multi-account would mirror the email-smart pattern; deferred to Phase 5.5.
- **Recurring series scope.** `update_event` / `cancel_event` on a recurring event id touch the entire series. To touch a single occurrence, pass the instance id format `<event_id>_<YYYYMMDDTHHMMSSZ>` (Google's convention). Explicit `scope` parameter is on the deferred list.
- **Free/busy ACL.** `find_meeting_time`'s `my_calendar_ids` only works on calendars the bound account has access to. External participants' availability comes in via `extra_busy` instead.
- **`gmail.delete` is not the model here.** Calendar-smart can `cancel_event` (true delete; not recoverable from a Trash). The `confirm: true` gate is the only safety net — there's no two-stage trash like email-smart has.

## Out of scope (deferred to Phase 5.5)

- Multi-account.
- Explicit `scope: "this_instance" | "this_and_following" | "all"` parameter on recurring-series updates / cancels.
- Event color, visibility, transparency setters.
- Reminder customization (currently uses calendar default).
- Free/busy across other people's calendars where the user has no ACL (would need workspace domain delegation).
- Watch / push notifications.
- Drive attachments.
- Meet/Hangouts conference creation on insert (relies on calendar default).
- Auto-pagination across multi-page result sets (`pageToken` plumbing exists; no auto-loop).
- Live integration tests against real Google Calendar.
