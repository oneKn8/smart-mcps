import {
  AuthError,
  NotFoundError,
  UpstreamError,
  ValidationError,
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
  /**
   * Wave-2 filters. `eventTypes` and `privateExtendedProperty` need
   * repeated query-parameter encoding (`?eventTypes=focusTime&eventTypes=outOfOffice`,
   * `?privateExtendedProperty=key=value&privateExtendedProperty=other=v2`),
   * which the shared `appendSearch` helper does not support — so listEvents
   * builds the URL with `URLSearchParams.append` directly when these are set.
   */
  eventTypes?: string[];
  privateExtendedProperty?: Record<string, string>;
  showDeleted?: boolean;
  /**
   * When set, switches the call to incremental sync mode. Google rejects
   * `timeMin`/`timeMax`/`q`/`orderBy` in combination with `syncToken`, so
   * this method silently drops those params. `singleEvents=true` IS allowed
   * and required for sync to work.
   */
  syncToken?: string;
};

export type ListEventsResult = {
  items: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
  /**
   * Set to `true` when Google returns 410 Gone — the supplied `syncToken`
   * has expired (Google retains them for ~30 days) and the caller must
   * restart with no syncToken to do a full resync. `items` is empty in
   * this case and no token is returned.
   */
  syncTokenInvalid?: true;
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
   *
   * Optional filters mirror Google's API:
   * - `showHidden` — include calendars the user explicitly hid (default: false).
   * - `showDeleted` — include calendars the user deleted (default: false).
   * - `minAccessRole` — restrict to roles at or above this floor; valid
   *   values: `freeBusyReader`, `reader`, `writer`, `owner`.
   */
  async listCalendars(opts?: {
    showHidden?: boolean;
    showDeleted?: boolean;
    minAccessRole?: string;
  }): Promise<unknown[]> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts?.showHidden !== undefined) {
      searchParams.showHidden = opts.showHidden;
    }
    if (opts?.showDeleted !== undefined) {
      searchParams.showDeleted = opts.showDeleted;
    }
    if (opts?.minAccessRole !== undefined) {
      searchParams.minAccessRole = opts.minAccessRole;
    }
    let raw: { items?: unknown[] };
    try {
      raw = await fetchJson<{ items?: unknown[] }>(
        `${CALENDAR_API_BASE}/users/me/calendarList`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
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
   * POST /calendars — create a brand new secondary calendar. Google adds the
   * new calendar to the user's CalendarList automatically. The response is
   * the bare /calendars/{id} shape (no `accessRole`/`primary`/`selected`);
   * tools that want the per-user view re-fetch via `getCalendarListEntry`.
   */
  async insertCalendar(body: Record<string, unknown>): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(`${CALENDAR_API_BASE}/calendars`, {
        method: "POST",
        token,
        body,
      });
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * PATCH /calendars/{calendarId} — partial update of calendar metadata.
   * Only the fields present in `body` are touched. Returns the bare
   * /calendars/{id} shape; tools re-fetch the CalendarList entry for
   * per-user fields.
   */
  async patchCalendar(opts: {
    calendarId: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}`,
        { method: "PATCH", token, body: opts.body },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * DELETE /calendars/{calendarId} — permanently delete a secondary
   * calendar. Returns 204; resolved promise carries no value. Cannot delete
   * the primary calendar (Google rejects with 403); the tool layer guards
   * against that before issuing the request.
   */
  async deleteCalendar(opts: { calendarId: string }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /calendars/primary/clear — wipe ALL events from the primary
   * calendar. The calendar metadata is preserved. Returns 204; only valid
   * against the primary calendar (Google rejects on any other id), so the
   * endpoint is hardcoded here rather than parameterized.
   */
  async clearPrimaryCalendar(): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/primary/clear`,
        { method: "POST", token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /users/me/calendarList — subscribe to (add to your sidebar) an
   * existing calendar by id. The body MUST include `id`; optional fields
   * include `selected`, `hidden`, `colorId`, `backgroundColor`,
   * `foregroundColor`, `summaryOverride`, etc. Returns the new CalendarList
   * entry.
   *
   * `colorRgbFormat=true` query param tells Google to honor explicit hex
   * colors (`backgroundColor`/`foregroundColor`) instead of treating them
   * as a request to use the matching `colorId` palette entry.
   */
  async insertCalendarListEntry(opts: {
    body: Record<string, unknown>;
    colorRgbFormat?: boolean;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.colorRgbFormat === true) {
      searchParams.colorRgbFormat = true;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/users/me/calendarList`,
        {
          method: "POST",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * PATCH /users/me/calendarList/{calendarId} — partial update of a
   * subscribed calendar's per-user appearance (color, label, visibility,
   * default reminders, notification settings). Only fields in `body` are
   * touched. `colorRgbFormat=true` query enables explicit hex colors.
   */
  async patchCalendarListEntry(opts: {
    calendarId: string;
    body: Record<string, unknown>;
    colorRgbFormat?: boolean;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.colorRgbFormat === true) {
      searchParams.colorRgbFormat = true;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/users/me/calendarList/${encodeURIComponent(opts.calendarId)}`,
        {
          method: "PATCH",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * DELETE /users/me/calendarList/{calendarId} — unsubscribe from a
   * calendar (remove it from the user's sidebar). The underlying calendar
   * resource is unaffected; the user can re-subscribe later. Returns 204.
   */
  async deleteCalendarListEntry(opts: { calendarId: string }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/users/me/calendarList/${encodeURIComponent(opts.calendarId)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
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
   *
   * Optional query params:
   * - `conferenceDataVersion` — must be 1 to honor a `conferenceData.createRequest`
   *   block in the body (Google Meet auto-creation). Defaults to omitted.
   * - `supportsAttachments` — pass true when the body includes attachments.
   * - `sendUpdates` — controls invite emails: `all` (everyone), `externalOnly`
   *   (non-Google attendees only), `none` (silent). Defaults to omitted, which
   *   Google interprets as no email side-effect for newly created events.
   */
  async insertEvent(opts: {
    calendarId: string;
    body: Record<string, unknown>;
    conferenceDataVersion?: 0 | 1;
    supportsAttachments?: boolean;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.conferenceDataVersion !== undefined) {
      searchParams.conferenceDataVersion = opts.conferenceDataVersion;
    }
    if (opts.supportsAttachments !== undefined) {
      searchParams.supportsAttachments = opts.supportsAttachments;
    }
    if (opts.sendUpdates !== undefined) {
      searchParams.sendUpdates = opts.sendUpdates;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`,
        {
          method: "POST",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
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
   *
   * Optional query params (mirror `insertEvent`):
   * - `conferenceDataVersion` — must be 1 to add a `conferenceData.createRequest`
   *   on patch (i.e. attaching a Meet link to an existing event).
   * - `supportsAttachments` — pass true when the patch includes attachments.
   * - `sendUpdates` — invite-email behavior on update: `all`, `externalOnly`,
   *   or `none`. Defaults to omitted, which Google treats as `none` for PATCH.
   */
  async patchEvent(opts: {
    calendarId: string;
    eventId: string;
    body: Record<string, unknown>;
    conferenceDataVersion?: 0 | 1;
    supportsAttachments?: boolean;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.conferenceDataVersion !== undefined) {
      searchParams.conferenceDataVersion = opts.conferenceDataVersion;
    }
    if (opts.supportsAttachments !== undefined) {
      searchParams.supportsAttachments = opts.supportsAttachments;
    }
    if (opts.sendUpdates !== undefined) {
      searchParams.sendUpdates = opts.sendUpdates;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}`,
        {
          method: "PATCH",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
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
   * DELETE /calendars/{calendarId}/events/{eventId} — cancel/remove an event.
   * Returns 204 with an empty body on success; the resolved promise carries
   * no value.
   *
   * Two upstream conditions are mapped to NotFoundError:
   *   - 404: the event id was never valid (or already permanently deleted).
   *   - 410: a recurring-instance id whose parent series was deleted; the
   *     instance no longer exists and Google reports it as Gone.
   */
  async deleteEvent(opts: {
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}`,
        {
          method: "DELETE",
          token,
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Event \`${opts.eventId}\` not found in \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      // 410 Gone surfaces as UpstreamError because http.ts has no specific
      // mapping; we detect by status suffix in the message and rewrite to
      // NotFoundError so callers see a uniform "missing" error type.
      if (err instanceof UpstreamError && err.message.includes("→ 410")) {
        throw new NotFoundError(
          `Recurring event instance \`${opts.eventId}\` no longer exists.`,
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

  /**
   * POST /freeBusy with a single Google Group `id` plus `groupExpansionMax`
   * and `calendarExpansionMax` so the response carries one entry per member
   * calendar (not one combined busy block for the group). This is a thin
   * variant of `freeBusy` because the group case has a different request
   * shape and a different response semantics — the tool layer surfaces
   * per-member `busy[]` and per-member `errors[]` separately.
   *
   * Per-calendar `errors` (notFound, accessDenied, rateLimitExceeded) are
   * preserved in the raw response shape so the tool can report them
   * alongside successes instead of failing the whole call.
   */
  async freeBusyGroup(opts: {
    timeMin: string;
    timeMax: string;
    groupEmail: string;
    groupExpansionMax?: number;
    calendarExpansionMax?: number;
  }): Promise<{
    calendars: Record<
      string,
      { busy: { start: string; end: string }[]; errors?: unknown[] }
    >;
  }> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      items: [{ id: opts.groupEmail }],
    };
    if (opts.groupExpansionMax !== undefined) {
      body.groupExpansionMax = opts.groupExpansionMax;
    }
    if (opts.calendarExpansionMax !== undefined) {
      body.calendarExpansionMax = opts.calendarExpansionMax;
    }
    try {
      return await fetchJson<{
        calendars: Record<
          string,
          { busy: { start: string; end: string }[]; errors?: unknown[] }
        >;
      }>(`${CALENDAR_API_BASE}/freeBusy`, {
        method: "POST",
        token,
        body,
      });
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * GET /calendars/{calendarId}/events/{eventId}/instances — expand a
   * recurring event series into its concrete occurrences. Each instance
   * carries `recurringEventId` (master id) and `originalStartTime` (the
   * originally-scheduled slot, before any per-instance reschedule).
   *
   * Defaults: `maxResults=25`, `showDeleted=false`. The optional
   * `originalStart` filter narrows to a single occurrence by its original
   * slot — useful for confirming an instance exists before patching it.
   */
  async listInstances(opts: {
    calendarId: string;
    eventId: string;
    timeMin?: string;
    timeMax?: string;
    originalStart?: string;
    maxResults?: number;
    showDeleted?: boolean;
    pageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {
        maxResults: String(opts.maxResults ?? 25),
        showDeleted: opts.showDeleted === true ? "true" : "false",
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        originalStart: opts.originalStart,
        pageToken: opts.pageToken,
      };
    let raw: { items?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ items?: unknown[]; nextPageToken?: string }>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}/instances`,
        { token, searchParams },
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
    return {
      items: raw.items ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /**
   * GET /calendars/{calendarId}/acl — every share rule on the calendar.
   * Items are returned raw; the tool layer maps each to SlimAclRule. The
   * `items[]` envelope is normalized to a bare array for symmetry with
   * `listCalendars`.
   */
  async listAcl(opts: { calendarId: string }): Promise<unknown[]> {
    const token = await this.oauthClient.getAccessToken();
    let raw: { items?: unknown[] };
    try {
      raw = await fetchJson<{ items?: unknown[] }>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/acl`,
        { token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
    return raw.items ?? [];
  }

  /**
   * GET /calendars/{calendarId}/acl/{ruleId} — single share rule. A 404
   * from Google is rewritten into a NotFoundError that names both the rule
   * id and the calendar id, mirroring `getEvent`.
   */
  async getAclRule(opts: {
    calendarId: string;
    ruleId: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/acl/${encodeURIComponent(opts.ruleId)}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `ACL rule \`${opts.ruleId}\` not found on \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /calendars/{calendarId}/acl — grant access to a calendar. The body
   * MUST include `role` and `scope: { type, value? }`. `value` is omitted
   * for `scope.type === "default"` (anyone with the link); the tool layer
   * enforces that invariant before calling.
   *
   * `sendNotifications=true` (default at Google) emails the principal that
   * they've been granted access; pass `false` to share silently. The tool
   * surface mirrors this default.
   */
  async insertAclRule(opts: {
    calendarId: string;
    body: Record<string, unknown>;
    sendNotifications?: boolean;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.sendNotifications !== undefined) {
      searchParams.sendNotifications = opts.sendNotifications;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/acl`,
        {
          method: "POST",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * PUT /calendars/{calendarId}/acl/{ruleId} — replace an existing share
   * rule. Google requires the body to include the full `scope` block and
   * the new `role`; the tool layer fetches the existing rule first to
   * preserve scope, then mutates only the role.
   */
  async updateAclRule(opts: {
    calendarId: string;
    ruleId: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/acl/${encodeURIComponent(opts.ruleId)}`,
        { method: "PUT", token, body: opts.body },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `ACL rule \`${opts.ruleId}\` not found on \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * DELETE /calendars/{calendarId}/acl/{ruleId} — revoke an existing share
   * rule. Returns 204; the resolved promise carries no value. A 404 is
   * rewritten into a NotFoundError naming the rule id.
   */
  async deleteAclRule(opts: {
    calendarId: string;
    ruleId: string;
  }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/acl/${encodeURIComponent(opts.ruleId)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `ACL rule \`${opts.ruleId}\` not found on \`${opts.calendarId}\`.`,
          { cause: err },
        );
      }
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * GET /users/me/settings — every user-level calendar preference. Returns
   * raw `items[]` (each carries `{ id, value }`); the tool layer flattens
   * these into a `Record<string, string>`. Symmetric with `listCalendars`'
   * envelope normalization.
   */
  async listSettings(): Promise<unknown[]> {
    const token = await this.oauthClient.getAccessToken();
    let raw: { items?: unknown[] };
    try {
      raw = await fetchJson<{ items?: unknown[] }>(
        `${CALENDAR_API_BASE}/users/me/settings`,
        { token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
    return raw.items ?? [];
  }

  /**
   * GET /users/me/settings/{settingId} — single user-level preference.
   * Returns the raw `{ id, value }` resource so callers can inspect both.
   */
  async getSetting(settingId: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/users/me/settings/${encodeURIComponent(settingId)}`,
        { token },
      );
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * GET /colors — the event + calendar color palettes. Google updates this
   * rarely; the tool layer does no caching for now (defer optimization).
   * Returns the raw resource (`{ kind, updated, calendar, event }`) so
   * the tool maps it to its slim shape.
   */
  async getColors(): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(`${CALENDAR_API_BASE}/colors`, {
        token,
      });
    } catch (err) {
      throw mapCalendarAuthError(err, this.account);
    }
  }

  /**
   * POST /calendars/{calendarId}/events/{eventId}/move?destination=... —
   * move an event from one calendar to another WITHOUT recreating it.
   * The event id is preserved across the move. Google requires the
   * organizer to own both the source and destination calendars.
   *
   * 404s are remapped to NotFoundError naming the source event id, matching
   * `getEvent`/`patchEvent` behavior.
   */
  async moveEvent(opts: {
    calendarId: string;
    eventId: string;
    destination: string;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { destination: opts.destination };
    if (opts.sendUpdates !== undefined) {
      searchParams.sendUpdates = opts.sendUpdates;
    }
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}` +
          `/events/${encodeURIComponent(opts.eventId)}/move`,
        { method: "POST", token, searchParams },
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
   * GET /calendars/{calendarId} — the bare Calendar resource (NOT the
   * CalendarList entry). Carries `conferenceProperties` and the canonical
   * `summary`/`description`/`location`/`timeZone` fields without per-user
   * `accessRole`/`primary`/`selected`.
   *
   * 404s are remapped to NotFoundError naming the calendar id.
   */
  async getCalendarMetadata(calendarId: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}`,
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

  async listEvents(opts: ListEventsOpts): Promise<ListEventsResult> {
    const token = await this.oauthClient.getAccessToken();
    // Build the URL by hand so we can carry repeated query parameters
    // (`eventTypes` and `privateExtendedProperty` may appear multiple times).
    // `URL.searchParams.append` preserves duplicates; the shared
    // `appendSearch` helper in core uses `.set` and would clobber repeats.
    const url = new URL(
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`,
    );
    const params = url.searchParams;
    params.set("singleEvents", "true");
    params.set("maxResults", String(opts.maxResults ?? 50));
    if (opts.syncToken !== undefined) {
      // Sync mode: Google rejects timeMin/timeMax/q/orderBy when syncToken
      // is set. We silently drop them so callers can pass a uniform input
      // shape across both list-by-window and incremental-sync paths.
      params.set("syncToken", opts.syncToken);
    } else {
      if (opts.timeMin !== undefined) params.set("timeMin", opts.timeMin);
      if (opts.timeMax !== undefined) params.set("timeMax", opts.timeMax);
      if (opts.q !== undefined) params.set("q", opts.q);
      // Google withholds nextSyncToken when orderBy is set. Skip orderBy in
      // sync-init mode (showDeleted=true with no time window — the
      // documented "give me everything so I can capture a syncToken"
      // pattern); set orderBy=startTime in normal list mode for ergonomic
      // ordering.
      const isSyncInit =
        opts.showDeleted === true &&
        opts.timeMin === undefined &&
        opts.timeMax === undefined;
      if (!isSyncInit) params.set("orderBy", "startTime");
    }
    if (opts.pageToken !== undefined) params.set("pageToken", opts.pageToken);
    if (opts.showDeleted === true) params.set("showDeleted", "true");
    if (opts.eventTypes !== undefined) {
      for (const t of opts.eventTypes) params.append("eventTypes", t);
    }
    if (opts.privateExtendedProperty !== undefined) {
      for (const [k, v] of Object.entries(opts.privateExtendedProperty)) {
        params.append("privateExtendedProperty", `${k}=${v}`);
      }
    }

    let raw: {
      items?: unknown[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    try {
      raw = await fetchJson<{
        items?: unknown[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>(url.toString(), { token });
    } catch (err) {
      // 410 Gone = syncToken expired (Google retains them ~30 days). Return
      // a clean signal so the caller can restart with no syncToken.
      if (
        opts.syncToken !== undefined &&
        err instanceof UpstreamError &&
        err.message.includes("→ 410")
      ) {
        return { items: [], syncTokenInvalid: true };
      }
      throw mapCalendarAuthError(err, this.account);
    }
    const out: ListEventsResult = { items: raw.items ?? [] };
    if (raw.nextPageToken !== undefined) out.nextPageToken = raw.nextPageToken;
    if (raw.nextSyncToken !== undefined) out.nextSyncToken = raw.nextSyncToken;
    return out;
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
  // 400 from Google Calendar is almost always a malformed-event error with a
  // useful `errors[].message` in the body. Surface it inline so callers don't
  // have to dig into `.detail`. Keeps `ValidationError` so non-auth errors
  // don't get reclassified.
  if (err instanceof ValidationError) {
    const detail = (err as { detail?: unknown }).detail;
    const reason = extractGoogleErrorReason(detail);
    if (reason) {
      return new ValidationError(
        `${err.message} — ${reason}`,
        { detail, cause: err },
      );
    }
    return err;
  }
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    if (
      msg.includes("accessNotConfigured") ||
      msg.includes("SERVICE_DISABLED") ||
      msg.includes("has not been used in project")
    ) {
      return new AuthError(
        `Google Calendar API is not enabled on your Cloud project. ` +
          `Enable it at https://console.developers.google.com/apis/library/calendar-json.googleapis.com ` +
          `then wait ~30s for propagation.`,
        { cause: err },
      );
    }
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

/**
 * Extract Google's human-readable error reason from the parsed body the
 * core http layer attached as `.detail`. Google's standard shape is
 * `{ error: { errors: [{ message, reason }], message, code } }`.
 * Returns the most informative string, or null when nothing useful found.
 */
function extractGoogleErrorReason(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { error?: unknown };
  const errBlock = d.error;
  if (typeof errBlock !== "object" || errBlock === null) return null;
  const eb = errBlock as { message?: unknown; errors?: unknown };
  // Prefer the per-error message (more specific) over the top-level message.
  if (Array.isArray(eb.errors) && eb.errors.length > 0) {
    const first = eb.errors[0] as { message?: unknown; reason?: unknown };
    if (typeof first.message === "string" && first.message.length > 0) {
      return first.message;
    }
  }
  if (typeof eb.message === "string" && eb.message.length > 0) {
    return eb.message;
  }
  return null;
}
