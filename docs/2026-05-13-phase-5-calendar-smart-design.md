# Phase 5 — calendar-smart Design

Personal Google Calendar MCP. Read + write. Single account (`your-account`).

## Goal

Ship a 21-tool Google Calendar MCP that mirrors `email-smart`'s arc: thin REST client over Google Calendar API v3, slim mappers stripping upstream noise, smart-shortcut layer on top. Composes at the LLM level with `email-smart` (event_with_invite_preview) and `weather-smart` (outdoor_event_check). Lifts the existing `GoogleOAuthClient` from `email-smart` into `smart-mcp-core` so both MCPs share one tested implementation.

## Acceptance criteria

- 21 tools registered, all returning explicit `type Output = {...}` slim shapes.
- Boots clean under MCP stdio with `~/.santo-agent/oauth/your-account.calendar.json` present (smoke check exits 0). Throws `AuthError` at construction time when token file missing or scope insufficient.
- `GoogleOAuthClient` lives in `smart-mcp-core` and is consumed by both `email-smart` and `calendar-smart` with no behavior change to the email package.
- `bin/calendar-smart-auth.js` CLI mints a token at `~/.santo-agent/oauth/<account>.calendar.json` with scope `https://www.googleapis.com/auth/calendar`, reusing `~/.santo-agent/oauth/client.json` for the OAuth client id/secret.
- Time zone is auto-detected from the primary calendar on first call and cached on the client; agenda/availability tools render windows in that zone.
- Every tool that takes a calendar accepts optional `calendar_id`, defaulting to the literal string `"primary"`.
- Destructive tools (`cancel_event`) require `confirm: true`, surface a preview through `ConfirmRequiredError`.
- ~250 unit tests, all green. No live integration tests in the unit suite (live smoke after merge).
- Registered via `scripts/install-clients.sh` auto-discovery.
- `npm test` green across the entire monorepo (email-smart still passes after the OAuth refactor).
- Tag `phase-5-calendar-smart-mvp` pushed.

## Upstream

**Google Calendar API v3.** Base URL `https://www.googleapis.com/calendar/v3`. OAuth 2.0 bearer. JSON. Scope `https://www.googleapis.com/auth/calendar` (full r/w on all the user's calendars).

| Purpose | Endpoint |
|---------|----------|
| List events | `GET /calendars/{calendarId}/events` |
| Get event | `GET /calendars/{calendarId}/events/{eventId}` |
| Insert event | `POST /calendars/{calendarId}/events` |
| Update event | `PATCH /calendars/{calendarId}/events/{eventId}` |
| Quick add | `POST /calendars/{calendarId}/events/quickAdd?text=...` |
| Cancel event | `DELETE /calendars/{calendarId}/events/{eventId}` |
| List calendars | `GET /users/me/calendarList` |
| Get calendar | `GET /calendars/{calendarId}` |
| Free/busy | `POST /freeBusy` |

Pagination: `pageToken` + `maxResults`. Default per-tool `maxResults` cap is 50 (configurable up to 250 by tool input). 429 backoff handled by `core/fetchJson`.

## Architecture

Standard per-MCP layout (mirrors `email-smart`).

```
packages/calendar-smart/
  bin/
    calendar-smart-auth.ts   # OAuth flow CLI, compiled to dist/bin/calendar-smart-auth.js
  src/
    client.ts                # CalendarClient (REST methods over Google Calendar API)
    context.ts               # CalendarContext shape + buildContext()
    server.ts                # createMcpServer<CalendarContext>({...})
    null-helpers.ts          # nullableString / nullableNumber / nullableBoolean
    event-mapper.ts          # mapEvent: Google event -> SlimEvent
    calendar-mapper.ts       # mapCalendar: Google calendar -> SlimCalendar
    time-zone.ts             # tz cache + window math (today, this week, etc.)
    free-busy.ts             # busy-window math (merge, invert, find-gap >= N min)
    tools/
      index.ts               # aggregates 21 tool definitions
      events-read.ts         # list_events, get_event
      events-agenda.ts       # daily_agenda, weekly_agenda, next_event
      events-create.ts       # quick_add, create_event, respond_to_event
      events-update.ts       # update_event, reschedule, cancel_event
      availability.ts        # find_availability, busy_blocks, conflicts_check
      calendars.ts           # list_calendars, get_calendar
      shortcuts.ts           # daily_brief, weekly_brief, find_meeting_time, event_with_invite_preview, outdoor_event_check
      __tests__/<topic>.test.ts
    __tests__/
      client.test.ts
      wire.test.ts
      time-zone.test.ts
      free-busy.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

### Auth (lifted into core)

`packages/core/src/google-oauth.ts` exports `GoogleOAuthClient` (currently in `packages/email-smart/src/oauth.ts`). The class is moved verbatim except for the import path of `AuthError` / `UpstreamError`. Email-smart's `src/oauth.ts` is deleted; its `client.ts` and tests update to `import { GoogleOAuthClient } from "smart-mcp-core";`. After the move, `npm test --workspace email-smart` must remain green with no logical edits.

`CalendarClient` constructs its own `GoogleOAuthClient(account, home)` instance, but reads the token from `<account>.calendar.json` (not `<account>.json`). The class already accepts the file basename via the `account` parameter, so `calendar-smart` passes `"<account>.calendar"` and gets its own token slot for free. No code change required in `GoogleOAuthClient` itself.

### `calendar-smart-auth` CLI

```
node packages/calendar-smart/dist/bin/calendar-smart-auth.js <account>
```

Flow:
1. Read `~/.santo-agent/oauth/client.json` for client_id / client_secret.
2. Print authorization URL with scope `calendar`, prompt the user to paste the resulting code.
3. Exchange code → token, write `~/.santo-agent/oauth/<account>.calendar.json` with mode 600.
4. Print "OK. Restart Claude Code to pick up calendar-smart."

Mirrors how `email-smart` was originally bootstrapped, just with a different scope and filename suffix. CLI is a single TS file in `bin/`; build step compiles it alongside `server.ts` and `chmod +x` both via the shared `package.json` `build` script.

### Credential file

`~/.config/smart-mcps/.env` adds (commented placeholder, no value):

```
# --- calendar-smart ---
CALENDAR_DEFAULT_IDENTITY=your-account
```

Only one var. No default-calendar persistence (every tool takes optional `calendar_id`, defaults to `"primary"`). Token files live under `~/.santo-agent/oauth/`, never in `.env`.

### Time zone resolution

On `CalendarClient` construction, `tz` is `undefined`. First time any tool needs it, `client.ensureTimeZone()` runs:

1. `GET /users/me/calendarList/primary` → returns `{ timeZone: "America/Chicago", ... }`.
2. Cache on `private cachedTimeZone: string | undefined`.
3. Return cached value on subsequent calls.

All agenda + availability tools call `await client.ensureTimeZone()` before computing window bounds. `daily_agenda` "today" means midnight-to-midnight in the cached zone, not UTC.

`time-zone.ts` exposes pure functions: `startOfDay(date, tz) -> Date`, `endOfWeek(date, tz, weekStart) -> Date`, `formatIso(date, tz) -> string`. Implementation uses `Intl.DateTimeFormat` parts; no `dayjs` / `luxon` / `date-fns-tz` dependency. Verified manually for `America/Chicago` and `Asia/Dhaka` (covers the user's two relevant zones).

## Data shapes

```ts
type SlimEvent = {
  id: string;
  summary: string;
  start: string;                  // ISO 8601, with offset matching the cached tz
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: SlimAttendee[];
  meeting_url: string | null;     // pulled from conferenceData.entryPoints, falls back to scanning location for hangouts/meet/zoom URL
  calendar_id: string;
  organizer_email: string | null;
  recurrence: string[] | null;    // raw RRULE strings, null when single
  status: "confirmed" | "tentative" | "cancelled";
  html_link: string;
};

type SlimAttendee = {
  email: string;
  response: "accepted" | "declined" | "tentative" | "needsAction";
  optional: boolean;
};

type SlimCalendar = {
  id: string;
  summary: string;
  primary: boolean;
  time_zone: string;
  access_role: "owner" | "writer" | "reader" | "freeBusyReader";
  background_color: string | null;
};

type FreeBlock = {
  start: string;            // ISO 8601 with cached tz offset
  end: string;
  duration_minutes: number;
};

type BusyBlock = {
  start: string;
  end: string;
  calendar_id: string;
};
```

Field-stripping tests assert `Object.keys(result).sort()` against the explicit array above. Anything Google adds upstream (e.g. `iCalUID`, `etag`, `created`, `updated`, `kind`) is dropped at the mapper boundary.

## Tools (21 total)

### Read agenda (5)

| Tool | Input | Output |
|------|-------|--------|
| `list_events` | `{ calendar_id?, time_min?, time_max?, query?, max_results? }` | `{ events: SlimEvent[], next_page_token: string \| null }` |
| `get_event` | `{ event_id, calendar_id? }` | `{ event: SlimEvent }` |
| `daily_agenda` | `{ date?, calendar_id? }` (date defaults to today in tz) | `{ date, events: SlimEvent[] }` |
| `weekly_agenda` | `{ week_of?, calendar_id? }` (defaults to this week, Monday-based) | `{ week_start, week_end, events: SlimEvent[] }` |
| `next_event` | `{ within_hours?, calendar_id? }` (default 24h) | `{ event: SlimEvent \| null }` |

### Availability (3)

| Tool | Input | Output |
|------|-------|--------|
| `find_availability` | `{ duration_minutes, time_min, time_max, calendar_id? }` | `{ free_blocks: FreeBlock[] }` |
| `busy_blocks` | `{ time_min, time_max, calendar_ids?: string[] }` (default `["primary"]`, can pass any calendar IDs you have ACL on) | `{ busy: BusyBlock[] }` |
| `conflicts_check` | `{ start, end, calendar_id? }` | `{ conflicts: SlimEvent[] }` |

### Create / modify (6)

| Tool | Input | Output |
|------|-------|--------|
| `quick_add` | `{ text, calendar_id? }` | `{ event: SlimEvent }` (delegates to Google's `events.quickAdd`, NLP) |
| `create_event` | `{ summary, start, end, attendees?, location?, description?, recurrence?, calendar_id? }` | `{ event: SlimEvent }` |
| `update_event` | `{ event_id, calendar_id?, ...patch }` | `{ event: SlimEvent }` |
| `reschedule` | `{ event_id, start, end, calendar_id? }` (sugar for time-only update_event) | `{ event: SlimEvent }` |
| `cancel_event` | `{ event_id, calendar_id?, confirm? }` | `{ cancelled: true }` (destructive: `guardDestructive` with preview "Cancel '<summary>' on <start> in <calendar.summary> (<n> attendees)") |
| `respond_to_event` | `{ event_id, response: "accepted"\|"declined"\|"tentative", calendar_id? }` | `{ event: SlimEvent }` |

`update_event` and `reschedule` are NOT confirm-gated (reversible). `create_event` and `quick_add` are NOT confirm-gated (creating is reversible by `cancel_event`).

`update_event` on a recurring event ID updates the entire series. Updating a single occurrence requires the instance ID format `<event_id>_<YYYYMMDDTHHMMSSZ>` (Google's convention). Documented in the tool description; explicit `scope` parameter deferred to Phase 5.5.

### Calendar management (2)

| Tool | Input | Output |
|------|-------|--------|
| `list_calendars` | `{}` | `{ calendars: SlimCalendar[] }` |
| `get_calendar` | `{ calendar_id }` | `{ calendar: SlimCalendar }` |

### Smart shortcuts (5)

| Tool | Input | Output |
|------|-------|--------|
| `daily_brief` | `{ date?, calendar_id? }` | `{ date, total: n, events: SlimEvent[3], first_conflict: SlimEvent[2] \| null, biggest_free_block: FreeBlock \| null }` |
| `weekly_brief` | `{ week_of?, calendar_id? }` | `{ week_start, week_end, total: n, busiest_day: { date, count }, biggest_free_block: FreeBlock \| null, days: { date, count }[] }` |
| `find_meeting_time` | `{ duration_minutes, time_min, time_max, my_calendar_ids?: string[], extra_busy?: { start: string, end: string }[], top_n?: number }` | `{ slots: FreeBlock[] }` (queries `/freeBusy` for `my_calendar_ids`, merges with `extra_busy`, returns top N gaps ranked by earliest, capped at top_n=5 default) |
| `event_with_invite_preview` | `{ summary, start, end, attendees, location?, description?, calendar_id? }` | `{ create_event_payload: {...}, invite_email_subject: string, invite_email_body: string }` (subject = `Invite: <summary> on <date>`, body = templated `When: <start>-<end>\nWhere: <location>\n\n<description>`. LLM calls `create_event` then `email-smart.send_email` itself; no direct cross-MCP call) |
| `outdoor_event_check` | `{ event_id, calendar_id? }` | `{ event: SlimEvent, location: string \| null, hint: string }` where `hint = "Pass location to weather-smart.geocode then weather-smart.outdoor_window for forecast at this start time"`. No geocoding inside calendar-smart — that crosses a domain boundary. |

`find_meeting_time` design: any participants on Google calendars you have ACL on (shared family cal, future former-employer workspace cal) go in `my_calendar_ids` and are queried via `freeBusy.query`. External participants you can't see are passed in as raw `extra_busy` windows. Both modes work; both can be combined in one call.

## Destructive tool guards

Only `cancel_event` is destructive. Pattern matches existing codebase:

```ts
inputSchema: z.object({
  event_id: z.string(),
  calendar_id: z.string().optional().default("primary"),
  confirm: z.boolean().optional().default(false),
})
```

Handler fetches the event for the preview, then `guardDestructive({ confirm: input.confirm, preview: "Cancel '<summary>' on <start_iso> in <calendar_summary> (<attendee_count> attendees)" })` BEFORE issuing the DELETE.

## Error handling

| Upstream | Mapped error | Message contains |
|----------|--------------|------------------|
| 401 | `AuthError` | "Calendar token missing or expired for `<account>`. Run `node packages/calendar-smart/dist/bin/calendar-smart-auth.js <account>` to re-auth." |
| 403 (insufficient scope) | `AuthError` | "Calendar token for `<account>` has wrong scope. Re-run `calendar-smart-auth` to re-consent with `calendar` scope." |
| 404 | `NotFoundError` | "Event `<event_id>` not found in `<calendar_id>`." |
| 410 (recurring instance after series-delete) | `NotFoundError` | "Recurring event instance `<event_id>` no longer exists." |
| 429 | (handled by core retry, 3 attempts) | — |
| 5xx | `Error` (core fetchJson default) | — |

`ConfirmRequiredError` carries the preview verbatim, surfaces to the LLM caller.

## Conventions (inherited)

- TypeScript 5.7 ESM, Node 22+. Relative imports end in `.js`.
- Tool descriptions ≤ 15 tokens.
- No emojis, no AI/Claude/Anthropic mentions, no co-author lines.
- Conventional commits scoped `feat(calendar):` / `fix(calendar):` / `refactor(core):` for the OAuth lift.
- Tool inputs use `zod` 3.24, output types declared with explicit `type Output = {...}`.
- Schemas with `.optional().default(...)` get the `as unknown as z.ZodType<Input>` cast comment.

## Testing

- `msw 2.6` `setupServer` for client-level HTTP mocking against `googleapis.com/calendar/v3/*` and `oauth2.googleapis.com/token`.
- Tool-level tests stub the client directly via `vi.fn().mockResolvedValue(...)`.
- `vi.useFakeTimers()` + `vi.setSystemTime(new Date("2026-05-13T10:00:00-05:00"))` for any test that touches window math.
- Body-mapping tests use exact-key `expect(body).toEqual({...})`. Field-stripping tests assert sorted `Object.keys`.
- Fixtures use `evt_alpha`, `evt_beta`, `cal_personal`, `cal_work`. Never real attendee emails.
- Test isolation: AuthError-on-missing-token tests override `process.env.HOME` to a non-existent dir in `beforeEach` (saved/restored: HOME, CALENDAR_DEFAULT_IDENTITY).
- Time zone resolution tests cover `America/Chicago` (DST spring-forward and fall-back), `Asia/Dhaka` (UTC+06, no DST), and the case where "today" in `Asia/Dhaka` is "yesterday" in UTC (request at 03:00 local = 21:00 prev day UTC, daily window must still bound to local midnight).
- Free/busy math tests cover: empty calendar, single event, back-to-back events (zero gap), overlapping events from two calendars (merge), all-day event spanning the window, recurring event instances within window.
- Wire test asserts: 21 tools, snake_case names, unique, every name appears in this design doc.

Smoke check after build:

```bash
timeout 3 node packages/calendar-smart/dist/server.js < /dev/null
```

Exit 0 with the calendar token file present means stdio bootstraps cleanly.

## OAuth refactor scope

One commit titled `refactor(core): move GoogleOAuthClient into shared core`.

Files touched:
- `packages/core/src/google-oauth.ts` — new file, contents lifted from `packages/email-smart/src/oauth.ts` (only import paths change).
- `packages/core/src/index.ts` — re-export `GoogleOAuthClient` and `AuthorizedUserFile` type.
- `packages/email-smart/src/oauth.ts` — deleted.
- `packages/email-smart/src/client.ts` — `import { GoogleOAuthClient } from "smart-mcp-core";`.
- `packages/email-smart/src/__tests__/*.test.ts` — same import swap; no logical changes.
- `packages/email-smart/package.json` — no change (already depends on `smart-mcp-core: "*"`).

Acceptance: `npm test --workspace email-smart` passes with zero failures and no behavior changes (test snapshots, count, names all identical pre/post).

## Out of scope (Phase 5 deferrals → Phase 5.5 if needed)

- Multi-account (`CALENDAR_DEFAULT_IDENTITY` exists but only one account is wired; pattern from email-smart can be lifted later).
- Explicit `scope: "this_instance" | "this_and_following" | "all"` parameter on `update_event` / `cancel_event` for recurring series.
- Event color, visibility, transparency setters.
- Reminder customization (uses calendar default).
- Free/busy across other people's calendars where you have no ACL (would need workspace domain delegation).
- Watch / push notifications.
- Drive attachments.
- Meet/Hangouts conference creation on insert (currently relies on calendar default).
- Pagination beyond `pageToken` plumbing already present (no auto-paginate-everything behavior).
- Live integration tests against real Google Calendar.

## Phase doc tasks (12-task pattern)

The implementation plan (PLAN.md) is generated from this spec by the writing-plans skill. The intended task split:

1. **Scaffold** workspace + tsconfig + vitest config + package.json + bin entry point + smoke script.
2. **Lift OAuth** to core (move `GoogleOAuthClient` to `packages/core/src/google-oauth.ts`, swap email-smart imports, verify email-smart tests stay green).
3. **Auth CLI** (`bin/calendar-smart-auth.ts`) + manual OAuth flow + first token mint at `~/.santo-agent/oauth/your-account.calendar.json`.
4. **CalendarClient** + `listEvents` method + `time-zone.ts` (auto-detect + cache) + `event-mapper.ts` + `list_events` tool.
5. **Get + agenda trio** (`get_event`, `daily_agenda`, `weekly_agenda`, `next_event`).
6. **Calendar management** (`list_calendars`, `get_calendar`, `calendar-mapper.ts`).
7. **Availability trio** (`find_availability`, `busy_blocks`, `conflicts_check`, `free-busy.ts` math).
8. **Create trio** (`quick_add`, `create_event`, `respond_to_event`).
9. **Update / cancel trio** (`update_event`, `reschedule`, `cancel_event` with confirm gate).
10. **Smart shortcuts read** (`daily_brief`, `weekly_brief`).
11. **Smart shortcuts compose** (`find_meeting_time`, `event_with_invite_preview`, `outdoor_event_check`).
12. **Wire + README + smoke + tag** `phase-5-calendar-smart-mvp`.
