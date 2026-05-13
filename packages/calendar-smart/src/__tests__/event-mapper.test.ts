import { describe, it, expect } from "vitest";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimEvent> = [
  "id",
  "summary",
  "start",
  "end",
  "all_day",
  "location",
  "description",
  "attendees",
  "meeting_url",
  "calendar_id",
  "organizer_email",
  "recurrence",
  "status",
  "html_link",
];

function timedFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_alpha",
    summary: "Standup",
    start: { dateTime: "2026-05-13T10:00:00-05:00", timeZone: "America/Chicago" },
    end: { dateTime: "2026-05-13T10:30:00-05:00", timeZone: "America/Chicago" },
    htmlLink: "https://calendar.google.com/event?eid=alpha",
    status: "confirmed",
    ...over,
  };
}

function allDayFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_beta",
    summary: "Conference",
    start: { date: "2026-05-13" },
    end: { date: "2026-05-14" },
    htmlLink: "https://calendar.google.com/event?eid=beta",
    status: "confirmed",
    ...over,
  };
}

describe("mapEvent — timed event basics", () => {
  it("maps a minimal timed event to the slim shape", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.id).toBe("evt_alpha");
    expect(slim.summary).toBe("Standup");
    expect(slim.start).toBe("2026-05-13T10:00:00-05:00");
    expect(slim.end).toBe("2026-05-13T10:30:00-05:00");
    expect(slim.all_day).toBe(false);
    expect(slim.calendar_id).toBe("primary");
    expect(slim.html_link).toBe("https://calendar.google.com/event?eid=alpha");
    expect(slim.status).toBe("confirmed");
  });

  it("returns null for absent location and description", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.location).toBeNull();
    expect(slim.description).toBeNull();
  });

  it("returns empty array for absent attendees", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.attendees).toEqual([]);
  });

  it("returns null recurrence for non-recurring single event", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.recurrence).toBeNull();
  });

  it("returns null meeting_url when no conference data or URL anywhere", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.meeting_url).toBeNull();
  });

  it("returns null organizer_email when organizer block missing", () => {
    const slim = mapEvent(timedFixture(), "primary");
    expect(slim.organizer_email).toBeNull();
  });
});

describe("mapEvent — all-day event", () => {
  it("maps date-only start/end with all_day=true", () => {
    const slim = mapEvent(allDayFixture(), "cal_personal");
    expect(slim.all_day).toBe(true);
    expect(slim.start).toBe("2026-05-13");
    expect(slim.end).toBe("2026-05-14");
    expect(slim.calendar_id).toBe("cal_personal");
  });
});

describe("mapEvent — attendees", () => {
  it("maps attendees with response and optional flag", () => {
    const slim = mapEvent(
      timedFixture({
        attendees: [
          { email: "alpha@example.test", responseStatus: "accepted" },
          { email: "beta@example.test", responseStatus: "declined", optional: true },
          { email: "gamma@example.test", responseStatus: "needsAction" },
          { email: "delta@example.test", responseStatus: "tentative", optional: false },
        ],
      }),
      "primary",
    );
    expect(slim.attendees).toEqual([
      { email: "alpha@example.test", response: "accepted", optional: false },
      { email: "beta@example.test", response: "declined", optional: true },
      { email: "gamma@example.test", response: "needsAction", optional: false },
      { email: "delta@example.test", response: "tentative", optional: false },
    ]);
  });

  it("skips attendees missing email", () => {
    const slim = mapEvent(
      timedFixture({
        attendees: [
          { email: "alpha@example.test", responseStatus: "accepted" },
          { responseStatus: "needsAction" }, // no email
        ],
      }),
      "primary",
    );
    expect(slim.attendees).toHaveLength(1);
    expect(slim.attendees[0]?.email).toBe("alpha@example.test");
  });
});

describe("mapEvent — meeting_url priority", () => {
  it("prefers conferenceData.entryPoints[].uri where entryPointType=video", () => {
    const slim = mapEvent(
      timedFixture({
        location: "https://zoom.us/j/should-not-win",
        description: "see https://meet.google.com/should-not-win",
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1-555-0100" },
            { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
          ],
        },
      }),
      "primary",
    );
    expect(slim.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("falls back to scanning location for a meet/zoom/teams URL", () => {
    const slim = mapEvent(
      timedFixture({
        location: "Conf Room A and https://zoom.us/j/12345 join here",
      }),
      "primary",
    );
    expect(slim.meeting_url).toBe("https://zoom.us/j/12345");
  });

  it("falls back to scanning description when location has no URL", () => {
    const slim = mapEvent(
      timedFixture({
        location: "Conference Room A",
        description: "Dial in: https://teams.microsoft.com/l/meetup-join/xyz here",
      }),
      "primary",
    );
    expect(slim.meeting_url).toBe("https://teams.microsoft.com/l/meetup-join/xyz");
  });

  it("ignores non-video entry points entirely", () => {
    const slim = mapEvent(
      timedFixture({
        conferenceData: {
          entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555-0100" }],
        },
      }),
      "primary",
    );
    expect(slim.meeting_url).toBeNull();
  });
});

describe("mapEvent — recurrence", () => {
  it("preserves a non-empty recurrence array", () => {
    const slim = mapEvent(
      timedFixture({ recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] }),
      "primary",
    );
    expect(slim.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("treats an empty recurrence array as null", () => {
    const slim = mapEvent(timedFixture({ recurrence: [] }), "primary");
    expect(slim.recurrence).toBeNull();
  });
});

describe("mapEvent — status normalization", () => {
  it("passes through 'cancelled' status", () => {
    const slim = mapEvent(timedFixture({ status: "cancelled" }), "primary");
    expect(slim.status).toBe("cancelled");
  });

  it("passes through 'tentative' status", () => {
    const slim = mapEvent(timedFixture({ status: "tentative" }), "primary");
    expect(slim.status).toBe("tentative");
  });

  it("defaults to 'confirmed' when status field missing", () => {
    const fx = timedFixture();
    delete (fx as { status?: unknown }).status;
    const slim = mapEvent(fx, "primary");
    expect(slim.status).toBe("confirmed");
  });
});

describe("mapEvent — organizer", () => {
  it("extracts organizer.email when present", () => {
    const slim = mapEvent(
      timedFixture({ organizer: { email: "owner@example.test" } }),
      "primary",
    );
    expect(slim.organizer_email).toBe("owner@example.test");
  });
});

describe("mapEvent — field stripping", () => {
  it("returns exactly the 13 SlimEvent keys (no upstream noise)", () => {
    const slim = mapEvent(
      timedFixture({
        // Upstream noise that must NOT appear on the slim shape.
        iCalUID: "ical-1@google.com",
        etag: "etag-xyz",
        created: "2026-05-01T00:00:00.000Z",
        updated: "2026-05-12T00:00:00.000Z",
        kind: "calendar#event",
        reminders: { useDefault: true },
      }),
      "primary",
    );
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });

  it("all-day event also produces exactly the 13 SlimEvent keys", () => {
    const slim = mapEvent(allDayFixture({ etag: "x" }), "primary");
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
