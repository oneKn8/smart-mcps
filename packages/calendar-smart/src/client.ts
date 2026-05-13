import {
  AuthError,
  NotFoundError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_TOKEN_FILE_SUFFIX = ".calendar.json";
const CALENDAR_REQUIRED_SCOPE = "https://www.googleapis.com/auth/calendar";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/calendar-smart/dist/bin/calendar-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/calendar-smart/dist/bin/calendar-smart-auth.js ${account}`;
}

export type CalendarClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the calendar token-jar slot
   * (`<account>.calendar.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

export type ListEventsOpts = {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  maxResults?: number;
  pageToken?: string;
};

/**
 * REST client for Google Calendar API v3. Constructor builds (but does not
 * read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * Time-zone is auto-detected from the primary calendar via
 * `ensureTimeZone()` and cached for the lifetime of this process. Agenda
 * tools call `ensureTimeZone()` before computing window bounds so "today"
 * means midnight-to-midnight in the cached zone, not UTC.
 */
export class CalendarClient {
  static readonly TOKEN_FILE_SUFFIX = CALENDAR_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = CALENDAR_REQUIRED_SCOPE;

  private readonly oauthClient: GoogleOAuthClient;
  private cachedTimeZone: string | undefined;

  constructor(
    private readonly account: string,
    opts: CalendarClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: CALENDAR_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: CALENDAR_REQUIRED_SCOPE,
      });
  }

  /**
   * Account identifier this client is bound to. Mirrors the basename of
   * the token file under `~/.santo-agent/oauth/`. Read-only — used by
   * tools that surface the account in error messages.
   */
  getAccount(): string {
    return this.account;
  }

  /**
   * Resolve the user's email address from the bound account name. When
   * `account` already looks like an email (`contains @`) it is returned
   * verbatim; otherwise we append `@gmail.com`. Used by `respond_to_event`
   * to find the calling user's attendee record on an event.
   *
   * NOTE: this is a pragmatic shortcut, not a verified identity lookup.
   * For non-Gmail OAuth accounts this would need to read the token's
   * userinfo profile; out of scope for Phase 5.
   */
  getAccountEmail(): string {
    return this.account.includes("@") ? this.account : `${this.account}@gmail.com`;
  }

  /**
   * Cached time zone IANA identifier (e.g. `"America/Chicago"`) sourced
   * from the primary calendar. `undefined` until `ensureTimeZone()` runs
   * for the first time on this instance.
   */
  getCachedTimeZone(): string | undefined {
    return this.cachedTimeZone;
  }

  /**
   * Resolve and cache the user's primary calendar time zone. Subsequent
   * calls return the cached value without an HTTP round-trip. The result
   * is the IANA identifier Google records on the calendar resource (e.g.
   * `"America/Chicago"`, `"Asia/Dhaka"`).
   *
   * Throws `Error` if Google returns no `timeZone` field — that would
   * indicate either a corrupted upstream response or a calendar resource
   * shape change worth surfacing instead of silently substituting UTC.
   */
  async ensureTimeZone(): Promise<string> {
    if (this.cachedTimeZone !== undefined) return this.cachedTimeZone;
    const token = await this.oauthClient.getAccessToken();
    let cal: { timeZone?: unknown };
    try {
      cal = await fetchJson<{ timeZone?: unknown }>(
        `${CALENDAR_API_BASE}/users/me/calendarList/primary`,
        { token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
    if (typeof cal.timeZone !== "string" || cal.timeZone.length === 0) {
      throw new Error(
        `primary calendar response missing timeZone for account ${this.account}`,
      );
    }
    this.cachedTimeZone = cal.timeZone;
    return cal.timeZone;
  }

  /**
   * GET /users/me/calendarList — every calendar the user has on their list
   * (owned, subscribed, and shared). Each entry carries `accessRole` and
   * `primary` (the bare `/calendars/{id}` endpoint does not), which is why
   * we use this endpoint for the slim calendar mapper. Items are returned
   * raw; the tool layer maps to SlimCalendar.
   */
  async listCalendars(): Promise<unknown[]> {
    const token = await this.oauthClient.getAccessToken();
    let raw: { items?: unknown[] };
    try {
      raw = await fetchJson<{ items?: unknown[] }>(
        `${CALENDAR_API_BASE}/users/me/calendarList`,
        { token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
    return raw.items ?? [];
  }

  /**
   * GET /users/me/calendarList/{calendarId} — single calendarList entry.
   * Used over the bare `/calendars/{id}` endpoint because only the
   * calendarList shape carries `accessRole` and `primary`. A 404 is
   * rewritten into a NotFoundError naming the calendar id.
   */
  async getCalendarListEntry(calendarId: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/users/me/calendarList/${encodeURIComponent(calendarId)}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Calendar \`${calendarId}\` not found.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * GET /calendars/{calendarId}/events/{eventId} — single event resource.
   * Returns the raw upstream shape so callers feed it to `mapEvent` with
   * the calendar id they already know. A 404 from Google is rewritten
   * into a NotFoundError that names the event id and calendar id.
   */
  async getEvent(opts: {
    calendarId: string;
    eventId: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Event \`${opts.eventId}\` not found in \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /calendars/{calendarId}/events/quickAdd?text=... — natural-language
   * event creation. Google parses the free-text string ("Lunch with Bob
   * tomorrow at noon") and returns the resulting event resource.
   *
   * The request body is empty; the parsed text rides on the query string.
   * Returns the raw event resource so callers can feed it to `mapEvent`.
   */
  async quickAdd(opts: {
    calendarId: string;
    text: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/quickAdd`,
        {
          method: "POST",
          token,
          searchParams: { text: opts.text },
        },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /calendars/{calendarId}/events — create an event from a structured
   * body. The caller is responsible for shaping `body` (start/end as
   * `{ dateTime }` blocks, attendees as `{ email }` objects, etc.); this
   * method just wraps auth + transport.
   */
  async insertEvent(opts: {
    calendarId: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`,
        {
          method: "POST",
          token,
          body: opts.body,
        },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * PATCH /calendars/{calendarId}/events/{eventId} — partial update of an
   * existing event. Only the fields present in `body` are touched. Used by
   * `update_event`, `reschedule`, and `respond_to_event`.
   *
   * A 404 from Google is rewritten into a NotFoundError that names the
   * event id and calendar id, matching `getEvent`'s behavior.
   */
  async patchEvent(opts: {
    calendarId: string;
    eventId: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}`,
        {
          method: "PATCH",
          token,
          body: opts.body,
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Event \`${opts.eventId}\` not found in \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * GET /calendars/{calendarId}/events with `singleEvents=true` and
   * `orderBy=startTime` so recurring series are expanded into their
   * concrete instances within the requested window.
   *
   * Returns the raw `items` array and `nextPageToken` so callers map +
   * paginate. `items` is normalized to `[]` when Google omits it.
   */
  /**
   * POST /freeBusy — query busy windows across one or more calendars in a
   * `[timeMin, timeMax]` ISO range. The response shape mirrors Google
   * verbatim:
   *   `{ calendars: { <calendarId>: { busy: [{start,end}], errors? } } }`
   *
   * Per-calendar `errors` (e.g. notFound, accessDenied) are surfaced
   * unmodified so the tool layer can decide whether to ignore or escalate.
   */
  async freeBusy(opts: {
    timeMin: string;
    timeMax: string;
    calendarIds: string[];
  }): Promise<{
    calendars: Record<
      string,
      { busy: { start: string; end: string }[]; errors?: unknown[] }
    >;
  }> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<{
        calendars: Record<
          string,
          { busy: { start: string; end: string }[]; errors?: unknown[] }
        >;
      }>(`${CALENDAR_API_BASE}/freeBusy`, {
        method: "POST",
        token,
        body: {
          timeMin: opts.timeMin,
          timeMax: opts.timeMax,
          items: opts.calendarIds.map((id) => ({ id })),
        },
      });
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  async listEvents(
    opts: ListEventsOpts,
  ): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(opts.maxResults ?? 50),
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        q: opts.q,
        pageToken: opts.pageToken,
      };
    let raw: { items?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{
        items?: unknown[];
        nextPageToken?: string;
      }>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`,
        { token, searchParams },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
    return {
      items: raw.items ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the `calendar-smart-auth` CLI. `fetchJson` already
 * maps both statuses to AuthError generically; we re-throw a friendlier
 * one. Other error types pass through unchanged.
 */
function mapCalendarAuthError(err: unknown, account: string): unknown {
  if (err instanceof NotFoundError) return err;
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    return new AuthError(
      `calendar token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the calendar scope`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `calendar token rejected for account ${account}; ` +
        `re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}
