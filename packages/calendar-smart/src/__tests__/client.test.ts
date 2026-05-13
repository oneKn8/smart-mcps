import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, NotFoundError } from "smart-mcp-core";
import { CalendarClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const PRIMARY_LIST_URL = `${CALENDAR_API_BASE}/users/me/calendarList/primary`;
const PRIMARY_EVENTS_URL = `${CALENDAR_API_BASE}/calendars/primary/events`;
const PRIMARY_EVENT_URL = (id: string): string =>
  `${CALENDAR_API_BASE}/calendars/primary/events/${id}`;
const CALENDAR_LIST_URL = `${CALENDAR_API_BASE}/users/me/calendarList`;
const CALENDAR_LIST_ENTRY_URL = (id: string): string =>
  `${CALENDAR_API_BASE}/users/me/calendarList/${id}`;
const FREE_BUSY_URL = `${CALENDAR_API_BASE}/freeBusy`;
const CALENDARS_URL = `${CALENDAR_API_BASE}/calendars`;
const CALENDAR_URL = (id: string): string =>
  `${CALENDAR_API_BASE}/calendars/${id}`;
const CLEAR_PRIMARY_URL = `${CALENDAR_API_BASE}/calendars/primary/clear`;
const ACL_LIST_URL = (calendarId: string): string =>
  `${CALENDAR_API_BASE}/calendars/${calendarId}/acl`;
const ACL_RULE_URL = (calendarId: string, ruleId: string): string =>
  `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}` +
  `/acl/${encodeURIComponent(ruleId)}`;
const SETTINGS_LIST_URL = `${CALENDAR_API_BASE}/users/me/settings`;
const SETTING_URL = (id: string): string =>
  `${CALENDAR_API_BASE}/users/me/settings/${id}`;
const COLORS_URL = `${CALENDAR_API_BASE}/colors`;
const MOVE_EVENT_URL = (calendarId: string, eventId: string): string =>
  `${CALENDAR_API_BASE}/calendars/${calendarId}/events/${eventId}/move`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "calendar-client-test-"));
}

function writeCalendarTokenFile(
  home: string,
  account: string,
  payload: unknown,
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.calendar.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function fixtureFile(opts: { expiry: string; token?: string }) {
  return {
    token: opts.token ?? "test-access-token",
    refresh_token: "test-refresh-token",
    token_uri: TOKEN_URL,
    client_id: "test-client.apps.googleusercontent.com",
    client_secret: "test-secret",
    scopes: ["https://www.googleapis.com/auth/calendar"],
    expiry: opts.expiry,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-13T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("CalendarClient — constructor", () => {
  it("constructor is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new CalendarClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    const c = new CalendarClient("alice");
    expect(c.getAccount()).toBe("alice");
  });

  it("getCachedTimeZone is undefined on a fresh client", () => {
    const c = new CalendarClient("alice");
    expect(c.getCachedTimeZone()).toBeUndefined();
  });

  it("getAccountEmail appends @gmail.com when account has no @", () => {
    const c = new CalendarClient("your-account");
    expect(c.getAccountEmail()).toBe("your-account@gmail.com");
  });

  it("getAccountEmail returns account verbatim when it already contains @", () => {
    const c = new CalendarClient("alice@example.test");
    expect(c.getAccountEmail()).toBe("alice@example.test");
  });
});

describe("CalendarClient.ensureTimeZone", () => {
  it("returns the primary calendar's timeZone and caches it", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let hits = 0;
    server.use(
      http.get(PRIMARY_LIST_URL, () => {
        hits++;
        return HttpResponse.json({
          id: "primary",
          timeZone: "America/Chicago",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    expect(await c.ensureTimeZone()).toBe("America/Chicago");
    expect(c.getCachedTimeZone()).toBe("America/Chicago");
    // Second call hits cache, no new HTTP.
    expect(await c.ensureTimeZone()).toBe("America/Chicago");
    expect(hits).toBe(1);
  });

  it("throws when primary calendar response has no timeZone field", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_LIST_URL, () =>
        HttpResponse.json({ id: "primary" }),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.ensureTimeZone()).rejects.toThrow(/timeZone/);
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.ensureTimeZone()).rejects.toBeInstanceOf(AuthError);
  });

  it("wraps a 403 from Google as AuthError mentioning the re-auth command", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_LIST_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.ensureTimeZone()).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("calendar-smart-auth"),
    });
  });

  it("wraps a 401 from Google as AuthError mentioning the account", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_LIST_URL, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.ensureTimeZone()).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("alice"),
    });
  });
});

describe("CalendarClient.listEvents", () => {
  it("issues GET with singleEvents=true, orderBy=startTime, default maxResults=50", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    let bearer: string | null = null;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        bearer = request.headers.get("authorization");
        return HttpResponse.json({ items: [], nextPageToken: undefined });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listEvents({ calendarId: "primary" });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured?.searchParams.get("singleEvents")).toBe("true");
    expect(captured?.searchParams.get("orderBy")).toBe("startTime");
    expect(captured?.searchParams.get("maxResults")).toBe("50");
    expect(out.items).toEqual([]);
    expect(out.nextPageToken).toBeUndefined();
  });

  it("forwards optional timeMin, timeMax, q, pageToken, and a custom maxResults", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          items: [{ id: "evt_alpha" }],
          nextPageToken: "tok_next",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listEvents({
      calendarId: "primary",
      timeMin: "2026-05-13T00:00:00-05:00",
      timeMax: "2026-05-14T00:00:00-05:00",
      q: "standup",
      maxResults: 100,
      pageToken: "tok_in",
    });

    expect(captured?.searchParams.get("timeMin")).toBe(
      "2026-05-13T00:00:00-05:00",
    );
    expect(captured?.searchParams.get("timeMax")).toBe(
      "2026-05-14T00:00:00-05:00",
    );
    expect(captured?.searchParams.get("q")).toBe("standup");
    expect(captured?.searchParams.get("maxResults")).toBe("100");
    expect(captured?.searchParams.get("pageToken")).toBe("tok_in");
    expect(out.items).toEqual([{ id: "evt_alpha" }]);
    expect(out.nextPageToken).toBe("tok_next");
  });

  it("URL-encodes the calendarId when it contains special characters", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ items: [] });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listEvents({ calendarId: "alice@example.test" });

    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("normalizes a missing items array to []", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_EVENTS_URL, () => HttpResponse.json({})),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listEvents({ calendarId: "primary" });
    expect(out.items).toEqual([]);
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.listEvents({ calendarId: "primary" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.getEvent", () => {
  it("GETs /calendars/{calendarId}/events/{eventId} and returns the raw resource", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(PRIMARY_EVENT_URL("evt_alpha"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          id: "evt_alpha",
          summary: "Standup",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toEqual({ id: "evt_alpha", summary: "Standup" });
  });

  it("URL-encodes both the calendarId and eventId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/:eventId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "evt_x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.getEvent({
      calendarId: "alice@example.test",
      eventId: "evt with spaces",
    });
    expect(captured?.pathname).toContain("alice%40example.test");
    expect(captured?.pathname).toContain("evt%20with%20spaces");
  });

  it("wraps a 404 from Google as NotFoundError naming the event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_EVENT_URL("evt_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.getEvent({ calendarId: "primary", eventId: "evt_missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("evt_missing"),
    });
    await expect(
      c.getEvent({ calendarId: "primary", eventId: "evt_missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("CalendarClient.listCalendars", () => {
  it("GETs /users/me/calendarList and returns the items array", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(CALENDAR_LIST_URL, ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          items: [
            { id: "primary", summary: "Personal", primary: true },
            { id: "cal_work", summary: "Work" },
          ],
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listCalendars();
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toEqual([
      { id: "primary", summary: "Personal", primary: true },
      { id: "cal_work", summary: "Work" },
    ]);
  });

  it("normalizes a missing items array to []", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(http.get(CALENDAR_LIST_URL, () => HttpResponse.json({})));

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listCalendars();
    expect(out).toEqual([]);
  });

  it("forwards showHidden, showDeleted, minAccessRole as query params", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(CALENDAR_LIST_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listCalendars({
      showHidden: true,
      showDeleted: true,
      minAccessRole: "writer",
    });

    expect(captured?.searchParams.get("showHidden")).toBe("true");
    expect(captured?.searchParams.get("showDeleted")).toBe("true");
    expect(captured?.searchParams.get("minAccessRole")).toBe("writer");
  });

  it("omits the query string entirely when no filters are provided", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(CALENDAR_LIST_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listCalendars();
    expect(captured?.search).toBe("");
  });
});

describe("CalendarClient.getCalendarListEntry", () => {
  it("GETs /users/me/calendarList/{id} and returns the raw entry", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(CALENDAR_LIST_ENTRY_URL("cal_work"), () =>
        HttpResponse.json({
          id: "cal_work",
          summary: "Work",
          accessRole: "owner",
          timeZone: "America/Chicago",
        }),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getCalendarListEntry("cal_work");
    expect(out).toEqual({
      id: "cal_work",
      summary: "Work",
      accessRole: "owner",
      timeZone: "America/Chicago",
    });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/users/me/calendarList/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.getCalendarListEntry("alice@example.test");
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("wraps a 404 from Google as NotFoundError naming the calendar", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(CALENDAR_LIST_ENTRY_URL("cal_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.getCalendarListEntry("cal_missing")).rejects.toMatchObject(
      {
        name: "NotFoundError",
        message: expect.stringContaining("cal_missing"),
      },
    );
  });
});

describe("CalendarClient.freeBusy", () => {
  it("POSTs /freeBusy with timeMin, timeMax, and items array", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    let captured: unknown;
    server.use(
      http.post(FREE_BUSY_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          calendars: {
            primary: {
              busy: [
                {
                  start: "2026-05-13T15:00:00Z",
                  end: "2026-05-13T16:00:00Z",
                },
              ],
            },
          },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.freeBusy({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      calendarIds: ["primary"],
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      items: [{ id: "primary" }],
    });
    expect(out.calendars["primary"]?.busy).toEqual([
      { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
    ]);
  });

  it("forwards multiple calendar ids in the items array", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    server.use(
      http.post(FREE_BUSY_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({
          calendars: {
            cal_personal: { busy: [] },
            cal_work: { busy: [] },
          },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.freeBusy({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      calendarIds: ["cal_personal", "cal_work"],
    });

    expect(captured).toEqual({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      items: [{ id: "cal_personal" }, { id: "cal_work" }],
    });
    expect(Object.keys(out.calendars).sort()).toEqual([
      "cal_personal",
      "cal_work",
    ]);
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.freeBusy({
        timeMin: "2026-05-13T00:00:00Z",
        timeMax: "2026-05-14T00:00:00Z",
        calendarIds: ["primary"],
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("wraps a 403 from Google as AuthError mentioning the re-auth command", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.post(FREE_BUSY_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.freeBusy({
        timeMin: "2026-05-13T00:00:00Z",
        timeMax: "2026-05-14T00:00:00Z",
        calendarIds: ["primary"],
      }),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("calendar-smart-auth"),
    });
  });
});

describe("CalendarClient.quickAdd", () => {
  it("POSTs /calendars/{id}/events/quickAdd?text=... and returns the created event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    let bearer: string | null = null;
    server.use(
      http.post(
        `${PRIMARY_EVENTS_URL}/quickAdd`,
        ({ request }) => {
          captured = new URL(request.url);
          bearer = request.headers.get("authorization");
          return HttpResponse.json({
            id: "evt_alpha",
            summary: "Lunch with Bob",
          });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.quickAdd({
      calendarId: "primary",
      text: "Lunch with Bob tomorrow at noon",
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured?.searchParams.get("text")).toBe(
      "Lunch with Bob tomorrow at noon",
    );
    expect(out).toEqual({ id: "evt_alpha", summary: "Lunch with Bob" });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/quickAdd`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.quickAdd({
      calendarId: "alice@example.test",
      text: "Hello",
    });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.quickAdd({ calendarId: "primary", text: "x" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.insertEvent", () => {
  it("POSTs /calendars/{id}/events with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.post(PRIMARY_EVENTS_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "evt_alpha",
          summary: "Coffee",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.insertEvent({
      calendarId: "primary",
      body: {
        summary: "Coffee",
        start: { dateTime: "2026-05-13T10:00:00-05:00" },
        end: { dateTime: "2026-05-13T10:30:00-05:00" },
      },
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      summary: "Coffee",
      start: { dateTime: "2026-05-13T10:00:00-05:00" },
      end: { dateTime: "2026-05-13T10:30:00-05:00" },
    });
    expect(out).toEqual({ id: "evt_alpha", summary: "Coffee" });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertEvent({
      calendarId: "alice@example.test",
      body: { summary: "x" },
    });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.insertEvent({ calendarId: "primary", body: {} }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("forwards conferenceDataVersion, supportsAttachments, sendUpdates as query params", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "evt_alpha" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertEvent({
      calendarId: "primary",
      body: { summary: "x" },
      conferenceDataVersion: 1,
      supportsAttachments: true,
      sendUpdates: "all",
    });

    expect(captured?.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(captured?.searchParams.get("supportsAttachments")).toBe("true");
    expect(captured?.searchParams.get("sendUpdates")).toBe("all");
  });

  it("omits the query string entirely when no optional params are provided", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "evt_alpha" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertEvent({
      calendarId: "primary",
      body: { summary: "x" },
    });

    expect(captured?.search).toBe("");
  });
});

describe("CalendarClient.patchEvent", () => {
  it("PATCHes /calendars/{id}/events/{eventId} with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.patch(
        PRIMARY_EVENT_URL("evt_alpha"),
        async ({ request }) => {
          bearer = request.headers.get("authorization");
          captured = await request.json();
          return HttpResponse.json({
            id: "evt_alpha",
            summary: "Renamed",
          });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.patchEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: { summary: "Renamed" },
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({ summary: "Renamed" });
    expect(out).toEqual({ id: "evt_alpha", summary: "Renamed" });
  });

  it("URL-encodes the calendarId and eventId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/:eventId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchEvent({
      calendarId: "alice@example.test",
      eventId: "evt with spaces",
      body: {},
    });
    expect(captured?.pathname).toContain("alice%40example.test");
    expect(captured?.pathname).toContain("evt%20with%20spaces");
  });

  it("wraps a 404 from Google as NotFoundError naming the event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.patch(PRIMARY_EVENT_URL("evt_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.patchEvent({
        calendarId: "primary",
        eventId: "evt_missing",
        body: { summary: "x" },
      }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("evt_missing"),
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.patchEvent({
        calendarId: "primary",
        eventId: "evt_alpha",
        body: {},
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("forwards conferenceDataVersion, supportsAttachments, sendUpdates as query params", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(PRIMARY_EVENT_URL("evt_alpha"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "evt_alpha" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: { summary: "x" },
      conferenceDataVersion: 1,
      supportsAttachments: true,
      sendUpdates: "externalOnly",
    });

    expect(captured?.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(captured?.searchParams.get("supportsAttachments")).toBe("true");
    expect(captured?.searchParams.get("sendUpdates")).toBe("externalOnly");
  });

  it("omits the query string entirely when no optional params are provided", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(PRIMARY_EVENT_URL("evt_alpha"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "evt_alpha" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: { summary: "x" },
    });

    expect(captured?.search).toBe("");
  });
});

describe("CalendarClient.deleteEvent", () => {
  it("DELETEs /calendars/{id}/events/{eventId} and returns nothing on 204", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.delete(PRIMARY_EVENT_URL("evt_alpha"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteEvent({ calendarId: "primary", eventId: "evt_alpha" }),
    ).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
  });

  it("URL-encodes the calendarId and eventId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.delete(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/:eventId`,
        ({ request }) => {
          captured = new URL(request.url);
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.deleteEvent({
      calendarId: "alice@example.test",
      eventId: "evt with spaces",
    });
    expect(captured?.pathname).toContain("alice%40example.test");
    expect(captured?.pathname).toContain("evt%20with%20spaces");
  });

  it("wraps a 404 from Google as NotFoundError naming the event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.delete(PRIMARY_EVENT_URL("evt_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteEvent({ calendarId: "primary", eventId: "evt_missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("evt_missing"),
    });
  });

  it("wraps a 410 (gone, recurring instance) as NotFoundError with a recurring-instance message", async () => {
    // Real timers here: the core retry loop reaches 410 via UpstreamError and
    // sleeps between attempts; under fake timers the awaited setTimeout never
    // fires and the test would deadlock.
    vi.useRealTimers();
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2030-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.delete(PRIMARY_EVENT_URL("evt_recur_instance"), () =>
        HttpResponse.json(
          { error: { code: 410, message: "Gone" } },
          { status: 410 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteEvent({
        calendarId: "primary",
        eventId: "evt_recur_instance",
      }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringMatching(/recurring|no longer exists/i),
    });
  }, 10_000);

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.deleteEvent({ calendarId: "primary", eventId: "evt_alpha" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.listInstances", () => {
  const INSTANCES_URL = (eventId: string): string =>
    `${PRIMARY_EVENT_URL(eventId)}/instances`;

  it("GETs /events/{id}/instances with default maxResults=25 and showDeleted=false", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    let bearer: string | null = null;
    server.use(
      http.get(INSTANCES_URL("evt_alpha"), ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = new URL(request.url);
        return HttpResponse.json({ items: [], nextPageToken: undefined });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listInstances({
      calendarId: "primary",
      eventId: "evt_alpha",
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured?.searchParams.get("maxResults")).toBe("25");
    expect(captured?.searchParams.get("showDeleted")).toBe("false");
    expect(out.items).toEqual([]);
  });

  it("forwards optional timeMin, timeMax, originalStart, showDeleted, pageToken", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(INSTANCES_URL("evt_alpha"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          items: [{ id: "evt_alpha_20260513T150000Z" }],
          nextPageToken: "tok_next",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listInstances({
      calendarId: "primary",
      eventId: "evt_alpha",
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-20T00:00:00Z",
      originalStart: "2026-05-13T15:00:00Z",
      showDeleted: true,
      maxResults: 100,
      pageToken: "tok_in",
    });

    expect(captured?.searchParams.get("timeMin")).toBe("2026-05-13T00:00:00Z");
    expect(captured?.searchParams.get("timeMax")).toBe("2026-05-20T00:00:00Z");
    expect(captured?.searchParams.get("originalStart")).toBe(
      "2026-05-13T15:00:00Z",
    );
    expect(captured?.searchParams.get("showDeleted")).toBe("true");
    expect(captured?.searchParams.get("maxResults")).toBe("100");
    expect(captured?.searchParams.get("pageToken")).toBe("tok_in");
    expect(out.items).toEqual([{ id: "evt_alpha_20260513T150000Z" }]);
    expect(out.nextPageToken).toBe("tok_next");
  });

  it("URL-encodes the calendarId and eventId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/:eventId/instances`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ items: [] });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listInstances({
      calendarId: "alice@example.test",
      eventId: "evt with spaces",
    });
    expect(captured?.pathname).toContain("alice%40example.test");
    expect(captured?.pathname).toContain("evt%20with%20spaces");
  });

  it("normalizes a missing items array to []", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(INSTANCES_URL("evt_alpha"), () => HttpResponse.json({})),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listInstances({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
    expect(out.items).toEqual([]);
  });

  it("wraps a 404 from Google as NotFoundError naming the event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(INSTANCES_URL("evt_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.listInstances({ calendarId: "primary", eventId: "evt_missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("evt_missing"),
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.listInstances({ calendarId: "primary", eventId: "evt_alpha" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.listEvents — Wave 2 filters", () => {
  it("forwards eventTypes as a repeated query parameter", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listEvents({
      calendarId: "primary",
      eventTypes: ["focusTime", "outOfOffice"],
    });

    expect(captured?.searchParams.getAll("eventTypes")).toEqual([
      "focusTime",
      "outOfOffice",
    ]);
  });

  it("forwards privateExtendedProperty as repeated key=value pairs", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listEvents({
      calendarId: "primary",
      privateExtendedProperty: { trace_id: "abc-123", project: "alpha" },
    });

    expect(
      captured?.searchParams.getAll("privateExtendedProperty").sort(),
    ).toEqual(["project=alpha", "trace_id=abc-123"].sort());
  });

  it("forwards showDeleted=true when requested", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listEvents({ calendarId: "primary", showDeleted: true });

    expect(captured?.searchParams.get("showDeleted")).toBe("true");
  });

  it("syncToken forwards as syncToken and omits incompatible timeMin/timeMax/q/orderBy", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(PRIMARY_EVENTS_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({
          items: [],
          nextSyncToken: "tok_sync_next",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listEvents({
      calendarId: "primary",
      syncToken: "tok_sync_in",
      // These would normally be forwarded but must be SKIPPED when
      // syncToken is set (Google rejects the combination).
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      q: "standup",
    });

    expect(captured?.searchParams.get("syncToken")).toBe("tok_sync_in");
    expect(captured?.searchParams.get("timeMin")).toBeNull();
    expect(captured?.searchParams.get("timeMax")).toBeNull();
    expect(captured?.searchParams.get("q")).toBeNull();
    expect(captured?.searchParams.get("orderBy")).toBeNull();
    // singleEvents IS still allowed with syncToken and recommended for parity
    // with the non-sync path.
    expect(captured?.searchParams.get("singleEvents")).toBe("true");
  });

  it("returns nextSyncToken when Google emits one", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_EVENTS_URL, () =>
        HttpResponse.json({
          items: [],
          nextSyncToken: "tok_sync_emitted",
        }),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listEvents({ calendarId: "primary" });
    expect(out.nextSyncToken).toBe("tok_sync_emitted");
  });

  it("returns syncTokenInvalid=true when Google responds 410 Gone", async () => {
    // Real timers because the retry loop sleeps between 410s on each attempt.
    vi.useRealTimers();
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2030-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(PRIMARY_EVENTS_URL, () =>
        HttpResponse.json(
          { error: { code: 410, message: "Sync token expired" } },
          { status: 410 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listEvents({
      calendarId: "primary",
      syncToken: "tok_old",
    });
    expect(out.syncTokenInvalid).toBe(true);
    expect(out.items).toEqual([]);
  }, 10_000);
});

// =============================================================================
// Wave 3: Calendars resource (create / patch / delete / clear-primary)
// =============================================================================

describe("CalendarClient.insertCalendar", () => {
  it("POSTs /calendars with the supplied body and returns the raw resource", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.post(CALENDARS_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "cal_new",
          summary: "Side Project",
          timeZone: "America/Chicago",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.insertCalendar({
      summary: "Side Project",
      timeZone: "America/Chicago",
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      summary: "Side Project",
      timeZone: "America/Chicago",
    });
    expect(out).toEqual({
      id: "cal_new",
      summary: "Side Project",
      timeZone: "America/Chicago",
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.insertCalendar({ summary: "x" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.patchCalendar", () => {
  it("PATCHes /calendars/{id} with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.patch(CALENDAR_URL("cal_new"), async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "cal_new",
          summary: "Renamed",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.patchCalendar({
      calendarId: "cal_new",
      body: { summary: "Renamed", description: "Updated" },
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({ summary: "Renamed", description: "Updated" });
    expect(out).toEqual({ id: "cal_new", summary: "Renamed" });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(
        `${CALENDAR_API_BASE}/calendars/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchCalendar({
      calendarId: "alice@example.test",
      body: { summary: "x" },
    });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.patchCalendar({ calendarId: "primary", body: {} }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.deleteCalendar", () => {
  it("DELETEs /calendars/{id} and returns nothing on 204", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.delete(CALENDAR_URL("cal_new"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteCalendar({ calendarId: "cal_new" }),
    ).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.delete(
        `${CALENDAR_API_BASE}/calendars/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.deleteCalendar({ calendarId: "alice@example.test" });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.deleteCalendar({ calendarId: "cal_x" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.clearPrimaryCalendar", () => {
  it("POSTs /calendars/primary/clear and returns nothing on 204", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    let method: string | undefined;
    server.use(
      http.post(CLEAR_PRIMARY_URL, ({ request }) => {
        bearer = request.headers.get("authorization");
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.clearPrimaryCalendar()).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
    expect(method).toBe("POST");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.clearPrimaryCalendar()).rejects.toBeInstanceOf(AuthError);
  });
});

// =============================================================================
// Wave 3: CalendarList subscription (insert / patch / delete)
// =============================================================================

describe("CalendarClient.insertCalendarListEntry", () => {
  it("POSTs /users/me/calendarList with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.post(CALENDAR_LIST_URL, async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "cal_team",
          summary: "Team",
          accessRole: "reader",
          timeZone: "America/Chicago",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.insertCalendarListEntry({
      body: { id: "cal_team", selected: true },
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({ id: "cal_team", selected: true });
    expect(out).toEqual({
      id: "cal_team",
      summary: "Team",
      accessRole: "reader",
      timeZone: "America/Chicago",
    });
  });

  it("forwards colorRgbFormat=true as a query param when set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(CALENDAR_LIST_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "cal_team" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertCalendarListEntry({
      body: { id: "cal_team", backgroundColor: "#ff0000" },
      colorRgbFormat: true,
    });
    expect(captured?.searchParams.get("colorRgbFormat")).toBe("true");
  });

  it("omits the query string when colorRgbFormat is not set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(CALENDAR_LIST_URL, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "cal_team" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertCalendarListEntry({ body: { id: "cal_team" } });
    expect(captured?.search).toBe("");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.insertCalendarListEntry({ body: { id: "x" } }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.patchCalendarListEntry", () => {
  it("PATCHes /users/me/calendarList/{id} with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.patch(CALENDAR_LIST_ENTRY_URL("cal_team"), async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "cal_team",
          summary: "Team",
          summaryOverride: "Renamed",
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.patchCalendarListEntry({
      calendarId: "cal_team",
      body: { summaryOverride: "Renamed", hidden: true },
    });

    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      summaryOverride: "Renamed",
      hidden: true,
    });
    expect(out).toEqual({
      id: "cal_team",
      summary: "Team",
      summaryOverride: "Renamed",
    });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(
        `${CALENDAR_API_BASE}/users/me/calendarList/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchCalendarListEntry({
      calendarId: "alice@example.test",
      body: { hidden: true },
    });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("forwards colorRgbFormat=true as a query param when set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.patch(CALENDAR_LIST_ENTRY_URL("cal_team"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "cal_team" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.patchCalendarListEntry({
      calendarId: "cal_team",
      body: { backgroundColor: "#00ff00" },
      colorRgbFormat: true,
    });
    expect(captured?.searchParams.get("colorRgbFormat")).toBe("true");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.patchCalendarListEntry({ calendarId: "x", body: {} }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.deleteCalendarListEntry", () => {
  it("DELETEs /users/me/calendarList/{id} and returns nothing on 204", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.delete(CALENDAR_LIST_ENTRY_URL("cal_team"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteCalendarListEntry({ calendarId: "cal_team" }),
    ).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.delete(
        `${CALENDAR_API_BASE}/users/me/calendarList/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.deleteCalendarListEntry({ calendarId: "alice@example.test" });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.deleteCalendarListEntry({ calendarId: "x" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

// =============================================================================
// Wave 4: ACL (sharing)
// =============================================================================

describe("CalendarClient.listAcl", () => {
  it("GETs /calendars/{id}/acl and returns items[]", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(ACL_LIST_URL("primary"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          items: [
            {
              id: "user:alice@example.test",
              role: "reader",
              scope: { type: "user", value: "alice@example.test" },
            },
            {
              id: "default",
              role: "freeBusyReader",
              scope: { type: "default" },
            },
          ],
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listAcl({ calendarId: "primary" });
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toHaveLength(2);
  });

  it("normalizes a missing items array to []", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(ACL_LIST_URL("primary"), () => HttpResponse.json({})),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listAcl({ calendarId: "primary" });
    expect(out).toEqual([]);
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId/acl`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ items: [] });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.listAcl({ calendarId: "alice@example.test" });
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.listAcl({ calendarId: "primary" }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.getAclRule", () => {
  it("GETs /calendars/{id}/acl/{ruleId} and returns the raw rule", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(
        ACL_RULE_URL("primary", "user:alice@example.test"),
        () =>
          HttpResponse.json({
            id: "user:alice@example.test",
            role: "writer",
            scope: { type: "user", value: "alice@example.test" },
          }),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getAclRule({
      calendarId: "primary",
      ruleId: "user:alice@example.test",
    });
    expect(out).toEqual({
      id: "user:alice@example.test",
      role: "writer",
      scope: { type: "user", value: "alice@example.test" },
    });
  });

  it("URL-encodes the ruleId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId/acl/:ruleId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.getAclRule({
      calendarId: "primary",
      ruleId: "user:bob@example.test",
    });
    expect(captured?.pathname).toContain("user%3Abob%40example.test");
  });

  it("wraps a 404 from Google as NotFoundError naming the rule", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(ACL_RULE_URL("primary", "user:missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.getAclRule({ calendarId: "primary", ruleId: "user:missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("user:missing"),
    });
  });
});

describe("CalendarClient.insertAclRule", () => {
  it("POSTs /calendars/{id}/acl with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let bearer: string | null = null;
    server.use(
      http.post(ACL_LIST_URL("primary"), async ({ request }) => {
        bearer = request.headers.get("authorization");
        captured = await request.json();
        return HttpResponse.json({
          id: "user:bob@example.test",
          role: "reader",
          scope: { type: "user", value: "bob@example.test" },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.insertAclRule({
      calendarId: "primary",
      body: {
        role: "reader",
        scope: { type: "user", value: "bob@example.test" },
      },
    });
    expect(bearer).toBe("Bearer test-access-token");
    expect(captured).toEqual({
      role: "reader",
      scope: { type: "user", value: "bob@example.test" },
    });
    expect(out).toMatchObject({ id: "user:bob@example.test" });
  });

  it("forwards sendNotifications=true as a query param when set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(ACL_LIST_URL("primary"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "x" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertAclRule({
      calendarId: "primary",
      body: { role: "reader", scope: { type: "default" } },
      sendNotifications: true,
    });
    expect(captured?.searchParams.get("sendNotifications")).toBe("true");
  });

  it("forwards sendNotifications=false as a query param when set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(ACL_LIST_URL("primary"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "x" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertAclRule({
      calendarId: "primary",
      body: { role: "reader", scope: { type: "default" } },
      sendNotifications: false,
    });
    expect(captured?.searchParams.get("sendNotifications")).toBe("false");
  });

  it("omits the query string when sendNotifications is unset", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(ACL_LIST_URL("primary"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "x" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.insertAclRule({
      calendarId: "primary",
      body: { role: "reader", scope: { type: "default" } },
    });
    expect(captured?.search).toBe("");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.insertAclRule({ calendarId: "primary", body: {} }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.updateAclRule", () => {
  it("PUTs /calendars/{id}/acl/{ruleId} with the supplied body", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    let method: string | undefined;
    server.use(
      http.put(
        ACL_RULE_URL("primary", "user:bob@example.test"),
        async ({ request }) => {
          method = request.method;
          captured = await request.json();
          return HttpResponse.json({
            id: "user:bob@example.test",
            role: "writer",
            scope: { type: "user", value: "bob@example.test" },
          });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.updateAclRule({
      calendarId: "primary",
      ruleId: "user:bob@example.test",
      body: {
        role: "writer",
        scope: { type: "user", value: "bob@example.test" },
      },
    });
    expect(method).toBe("PUT");
    expect(captured).toEqual({
      role: "writer",
      scope: { type: "user", value: "bob@example.test" },
    });
    expect(out).toMatchObject({ role: "writer" });
  });

  it("wraps a 404 from Google as NotFoundError naming the rule", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.put(ACL_RULE_URL("primary", "user:missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.updateAclRule({
        calendarId: "primary",
        ruleId: "user:missing",
        body: { role: "writer" },
      }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("user:missing"),
    });
  });
});

describe("CalendarClient.deleteAclRule", () => {
  it("DELETEs /calendars/{id}/acl/{ruleId} and returns nothing on 204", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.delete(
        ACL_RULE_URL("primary", "user:bob@example.test"),
        ({ request }) => {
          bearer = request.headers.get("authorization");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteAclRule({
        calendarId: "primary",
        ruleId: "user:bob@example.test",
      }),
    ).resolves.toBeUndefined();
    expect(bearer).toBe("Bearer test-access-token");
  });

  it("wraps a 404 from Google as NotFoundError naming the rule", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.delete(ACL_RULE_URL("primary", "user:missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.deleteAclRule({ calendarId: "primary", ruleId: "user:missing" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("user:missing"),
    });
  });
});

// =============================================================================
// Wave 4: Settings (read-only)
// =============================================================================

describe("CalendarClient.listSettings", () => {
  it("GETs /users/me/settings and returns items[]", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(SETTINGS_LIST_URL, ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          items: [
            { id: "timezone", value: "America/Chicago" },
            { id: "weekStart", value: "1" },
          ],
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listSettings();
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toEqual([
      { id: "timezone", value: "America/Chicago" },
      { id: "weekStart", value: "1" },
    ]);
  });

  it("normalizes a missing items array to []", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(SETTINGS_LIST_URL, () => HttpResponse.json({})),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.listSettings();
    expect(out).toEqual([]);
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.listSettings()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("CalendarClient.getSetting", () => {
  it("GETs /users/me/settings/{id} and returns the raw setting", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(SETTING_URL("timezone"), () =>
        HttpResponse.json({ id: "timezone", value: "America/Chicago" }),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getSetting("timezone");
    expect(out).toEqual({ id: "timezone", value: "America/Chicago" });
  });

  it("URL-encodes the setting id", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/users/me/settings/:id`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x", value: "y" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.getSetting("weird id");
    expect(captured?.pathname).toContain("weird%20id");
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.getSetting("timezone")).rejects.toBeInstanceOf(AuthError);
  });
});

// =============================================================================
// Wave 4: Colors
// =============================================================================

describe("CalendarClient.getColors", () => {
  it("GETs /colors and returns the raw palette", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(COLORS_URL, ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          kind: "calendar#colors",
          updated: "2026-05-13T00:00:00Z",
          calendar: {
            "1": { background: "#ac725e", foreground: "#1d1d1d" },
          },
          event: {
            "1": { background: "#a4bdfc", foreground: "#1d1d1d" },
          },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getColors();
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toMatchObject({
      updated: "2026-05-13T00:00:00Z",
      calendar: { "1": { background: "#ac725e", foreground: "#1d1d1d" } },
      event: { "1": { background: "#a4bdfc", foreground: "#1d1d1d" } },
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.getColors()).rejects.toBeInstanceOf(AuthError);
  });
});

// =============================================================================
// Wave 4: move event
// =============================================================================

describe("CalendarClient.moveEvent", () => {
  it("POSTs /calendars/{id}/events/{eventId}/move?destination=...", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    let method: string | undefined;
    server.use(
      http.post(
        MOVE_EVENT_URL("primary", "evt_alpha"),
        ({ request }) => {
          captured = new URL(request.url);
          method = request.method;
          return HttpResponse.json({
            id: "evt_alpha",
            summary: "Standup",
          });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.moveEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
      destination: "cal_work",
    });
    expect(method).toBe("POST");
    expect(captured?.searchParams.get("destination")).toBe("cal_work");
    expect(out).toMatchObject({ id: "evt_alpha" });
  });

  it("forwards sendUpdates as a query param when set", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(MOVE_EVENT_URL("primary", "evt_alpha"), ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({ id: "evt_alpha" });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.moveEvent({
      calendarId: "primary",
      eventId: "evt_alpha",
      destination: "cal_work",
      sendUpdates: "all",
    });
    expect(captured?.searchParams.get("sendUpdates")).toBe("all");
  });

  it("URL-encodes the calendarId and eventId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.post(
        `${CALENDAR_API_BASE}/calendars/:calendarId/events/:eventId/move`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.moveEvent({
      calendarId: "alice@example.test",
      eventId: "evt with spaces",
      destination: "cal_work",
    });
    expect(captured?.pathname).toContain("alice%40example.test");
    expect(captured?.pathname).toContain("evt%20with%20spaces");
  });

  it("wraps a 404 from Google as NotFoundError naming the event", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.post(MOVE_EVENT_URL("primary", "evt_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(
      c.moveEvent({
        calendarId: "primary",
        eventId: "evt_missing",
        destination: "cal_work",
      }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("evt_missing"),
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.moveEvent({
        calendarId: "primary",
        eventId: "evt_x",
        destination: "cal_work",
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

// =============================================================================
// Wave 4: get bare Calendar resource
// =============================================================================

describe("CalendarClient.getCalendarMetadata", () => {
  it("GETs /calendars/{id} and returns the raw resource", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let bearer: string | null = null;
    server.use(
      http.get(CALENDAR_URL("cal_work"), ({ request }) => {
        bearer = request.headers.get("authorization");
        return HttpResponse.json({
          kind: "calendar#calendar",
          etag: "etag-abc",
          id: "cal_work",
          summary: "Work",
          description: "Stuff",
          location: "Dallas",
          timeZone: "America/Chicago",
          conferenceProperties: {
            allowedConferenceSolutionTypes: ["hangoutsMeet"],
          },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.getCalendarMetadata("cal_work");
    expect(bearer).toBe("Bearer test-access-token");
    expect(out).toMatchObject({
      id: "cal_work",
      summary: "Work",
      timeZone: "America/Chicago",
      conferenceProperties: {
        allowedConferenceSolutionTypes: ["hangoutsMeet"],
      },
    });
  });

  it("URL-encodes the calendarId", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: URL | undefined;
    server.use(
      http.get(
        `${CALENDAR_API_BASE}/calendars/:calendarId`,
        ({ request }) => {
          captured = new URL(request.url);
          return HttpResponse.json({ id: "x" });
        },
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.getCalendarMetadata("alice@example.test");
    expect(captured?.pathname).toContain("alice%40example.test");
  });

  it("wraps a 404 from Google as NotFoundError naming the calendar", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    server.use(
      http.get(CALENDAR_URL("cal_missing"), () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await expect(c.getCalendarMetadata("cal_missing")).rejects.toMatchObject({
      name: "NotFoundError",
      message: expect.stringContaining("cal_missing"),
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(c.getCalendarMetadata("cal_x")).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

// =============================================================================
// Wave 4: freeBusyGroup
// =============================================================================

describe("CalendarClient.freeBusyGroup", () => {
  it("POSTs /freeBusy with single group item + expansion max params", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    server.use(
      http.post(FREE_BUSY_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({
          calendars: {
            "alice@example.test": {
              busy: [
                { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
              ],
            },
            "bob@example.test": {
              busy: [],
              errors: [{ domain: "global", reason: "notFound" }],
            },
          },
        });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    const out = await c.freeBusyGroup({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      groupEmail: "team@example.test",
      groupExpansionMax: 50,
      calendarExpansionMax: 25,
    });

    expect(captured).toEqual({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      items: [{ id: "team@example.test" }],
      groupExpansionMax: 50,
      calendarExpansionMax: 25,
    });
    expect(out.calendars["alice@example.test"]?.busy).toHaveLength(1);
    expect(out.calendars["bob@example.test"]?.errors).toEqual([
      { domain: "global", reason: "notFound" },
    ]);
  });

  it("omits expansion params from the body when not supplied", async () => {
    writeCalendarTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-05-13T13:00:00.000Z" }),
    );
    let captured: unknown;
    server.use(
      http.post(FREE_BUSY_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ calendars: {} });
      }),
    );

    const c = new CalendarClient("alice", { home: tmpHome });
    await c.freeBusyGroup({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      groupEmail: "team@example.test",
    });

    expect(captured).toEqual({
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-14T00:00:00Z",
      items: [{ id: "team@example.test" }],
    });
  });

  it("propagates AuthError when the calendar token file is missing", async () => {
    const c = new CalendarClient("ghost", { home: tmpHome });
    await expect(
      c.freeBusyGroup({
        timeMin: "2026-05-13T00:00:00Z",
        timeMax: "2026-05-14T00:00:00Z",
        groupEmail: "team@example.test",
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
