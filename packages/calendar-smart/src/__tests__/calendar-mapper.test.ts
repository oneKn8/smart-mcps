import { describe, it, expect } from "vitest";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimCalendar> = [
  "id",
  "summary",
  "primary",
  "time_zone",
  "access_role",
  "background_color",
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
  it("returns exactly the 6 SlimCalendar keys (no upstream noise)", () => {
    const slim = mapCalendar(
      fixture({
        // Upstream noise that must NOT appear on the slim shape.
        kind: "calendar#calendarListEntry",
        etag: "etag-abc",
        colorId: "7",
        foregroundColor: "#ffffff",
        selected: true,
        defaultReminders: [{ method: "popup", minutes: 10 }],
        notificationSettings: { notifications: [] },
        conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
      }),
    );
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
