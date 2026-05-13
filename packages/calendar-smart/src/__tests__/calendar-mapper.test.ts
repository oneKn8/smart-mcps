import { describe, it, expect } from "vitest";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimCalendar> = [
  "id",
  "summary",
  "primary",
  "time_zone",
  "access_role",
  "background_color",
  "foreground_color",
  "description",
  "location",
  "summary_override",
  "selected",
  "hidden",
];

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cal_personal",
    summary: "Personal",
    timeZone: "America/Chicago",
    accessRole: "owner",
    ...over,
  };
}

describe("mapCalendar — basics", () => {
  it("maps a minimal owned calendar with primary=false default", () => {
    const slim = mapCalendar(fixture());
    expect(slim.id).toBe("cal_personal");
    expect(slim.summary).toBe("Personal");
    expect(slim.primary).toBe(false);
    expect(slim.time_zone).toBe("America/Chicago");
    expect(slim.access_role).toBe("owner");
    expect(slim.background_color).toBeNull();
  });

  it("preserves primary=true when Google sets it", () => {
    const slim = mapCalendar(fixture({ primary: true }));
    expect(slim.primary).toBe(true);
  });

  it("preserves backgroundColor as background_color (snake_case rename)", () => {
    const slim = mapCalendar(fixture({ backgroundColor: "#0d58c7" }));
    expect(slim.background_color).toBe("#0d58c7");
  });

  it("non-string backgroundColor degrades to null", () => {
    const slim = mapCalendar(fixture({ backgroundColor: 12345 }));
    expect(slim.background_color).toBeNull();
  });

  it("preserves foregroundColor as foreground_color (snake_case rename)", () => {
    const slim = mapCalendar(fixture({ foregroundColor: "#ffffff" }));
    expect(slim.foreground_color).toBe("#ffffff");
  });

  it("non-string foregroundColor degrades to null", () => {
    const slim = mapCalendar(fixture({ foregroundColor: 12345 }));
    expect(slim.foreground_color).toBeNull();
  });

  it("preserves description and location strings", () => {
    const slim = mapCalendar(
      fixture({
        description: "Personal events",
        location: "Dallas, TX",
      }),
    );
    expect(slim.description).toBe("Personal events");
    expect(slim.location).toBe("Dallas, TX");
  });

  it("missing description and location degrade to null", () => {
    const slim = mapCalendar(fixture());
    expect(slim.description).toBeNull();
    expect(slim.location).toBeNull();
  });

  it("preserves summaryOverride as summary_override (CalendarList-only)", () => {
    const slim = mapCalendar(fixture({ summaryOverride: "My Work" }));
    expect(slim.summary_override).toBe("My Work");
  });

  it("missing summaryOverride degrades to null", () => {
    const slim = mapCalendar(fixture());
    expect(slim.summary_override).toBeNull();
  });
});

describe("mapCalendar — CalendarList visibility fields", () => {
  it("preserves selected=true when Google sets it", () => {
    const slim = mapCalendar(fixture({ selected: true }));
    expect(slim.selected).toBe(true);
  });

  it("preserves selected=false when Google sets it", () => {
    const slim = mapCalendar(fixture({ selected: false }));
    expect(slim.selected).toBe(false);
  });

  it("missing selected defaults to true (CalendarList visible by default)", () => {
    const slim = mapCalendar(fixture());
    expect(slim.selected).toBe(true);
  });

  it("preserves hidden=true when Google sets it", () => {
    const slim = mapCalendar(fixture({ hidden: true }));
    expect(slim.hidden).toBe(true);
  });

  it("missing hidden defaults to false", () => {
    const slim = mapCalendar(fixture());
    expect(slim.hidden).toBe(false);
  });
});

describe("mapCalendar — bare /calendars/{id} shape (no CalendarList fields)", () => {
  it("maps a /calendars/{id} response with no accessRole/primary/selected/hidden", () => {
    const slim = mapCalendar({
      kind: "calendar#calendar",
      etag: "etag-abc",
      id: "cal_new",
      summary: "New Cal",
      timeZone: "America/Chicago",
      description: "A fresh secondary",
      location: "Dallas",
    });
    expect(slim).toEqual({
      id: "cal_new",
      summary: "New Cal",
      primary: false,
      time_zone: "America/Chicago",
      access_role: "reader",
      background_color: null,
      foreground_color: null,
      description: "A fresh secondary",
      location: "Dallas",
      summary_override: null,
      selected: true,
      hidden: false,
    });
  });
});

describe("mapCalendar — access roles", () => {
  it.each([
    ["owner"],
    ["writer"],
    ["reader"],
    ["freeBusyReader"],
  ])("preserves accessRole=%s", (role) => {
    const slim = mapCalendar(fixture({ accessRole: role }));
    expect(slim.access_role).toBe(role);
  });

  it("falls back to 'reader' when accessRole is missing or invalid", () => {
    const fx = fixture();
    delete (fx as { accessRole?: unknown }).accessRole;
    const slim = mapCalendar(fx);
    expect(slim.access_role).toBe("reader");
  });
});

describe("mapCalendar — defaults / nulls", () => {
  it("missing summary degrades to empty string", () => {
    const fx = fixture();
    delete (fx as { summary?: unknown }).summary;
    const slim = mapCalendar(fx);
    expect(slim.summary).toBe("");
  });

  it("missing timeZone degrades to empty string", () => {
    const fx = fixture();
    delete (fx as { timeZone?: unknown }).timeZone;
    const slim = mapCalendar(fx);
    expect(slim.time_zone).toBe("");
  });
});

describe("mapCalendar — field stripping", () => {
  it("returns exactly the 12 SlimCalendar keys (no upstream noise)", () => {
    const slim = mapCalendar(
      fixture({
        // Upstream noise that must NOT appear on the slim shape.
        kind: "calendar#calendarListEntry",
        etag: "etag-abc",
        colorId: "7",
        defaultReminders: [{ method: "popup", minutes: 10 }],
        notificationSettings: { notifications: [] },
        conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
      }),
    );
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
