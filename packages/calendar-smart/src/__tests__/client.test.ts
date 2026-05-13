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
