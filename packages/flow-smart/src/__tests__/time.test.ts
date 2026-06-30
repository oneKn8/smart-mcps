import { describe, it, expect } from "vitest";
import {
  addDays,
  addMinutesIso,
  dateKeyInTz,
  mondayWeek,
  parseClock,
  tzMidnightIso,
  tzWallClockIso,
} from "../time.js";

describe("time helpers", () => {
  it("dateKeyInTz reads the local calendar date", () => {
    // 2026-07-01T02:00Z is still 2026-06-30 in Chicago (-05:00).
    const ref = new Date("2026-07-01T02:00:00Z");
    expect(dateKeyInTz("America/Chicago", ref)).toBe("2026-06-30");
    expect(dateKeyInTz("UTC", ref)).toBe("2026-07-01");
  });

  it("addDays does UTC calendar arithmetic with rollover", () => {
    expect(addDays("2026-07-01", 1)).toBe("2026-07-02");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("mondayWeek finds Monday-based bounds", () => {
    // 2026-07-01 is a Wednesday.
    expect(mondayWeek("2026-07-01")).toEqual({
      start: "2026-06-29",
      endInclusive: "2026-07-05",
      endExclusive: "2026-07-06",
    });
    // A Sunday belongs to the week that STARTED the prior Monday.
    expect(mondayWeek("2026-07-05").start).toBe("2026-06-29");
    // A Monday is its own week start.
    expect(mondayWeek("2026-06-29").start).toBe("2026-06-29");
  });

  it("tzMidnightIso anchors local midnight with the right offset", () => {
    // July = CDT (-05:00) in Chicago.
    expect(tzMidnightIso("2026-07-01", "America/Chicago")).toBe(
      "2026-07-01T00:00:00-05:00",
    );
    expect(tzMidnightIso("2026-07-01", "UTC")).toBe("2026-07-01T00:00:00+00:00");
  });

  it("tzMidnightIso lands on the correct calendar day across a midnight DST shift", () => {
    // America/Santiago falls back AT local midnight on 2026-04-05; a single-pass
    // offset inversion slips the instant onto 2026-04-04.
    const santiago = tzMidnightIso("2026-04-05", "America/Santiago");
    expect(dateKeyInTz("America/Santiago", new Date(santiago))).toBe("2026-04-05");

    // Asia/Beirut springs forward at local midnight on 2026-03-29, so 00:00
    // never exists (a gap); the instant must still read as 2026-03-29 locally.
    const beirut = tzMidnightIso("2026-03-29", "Asia/Beirut");
    expect(dateKeyInTz("Asia/Beirut", new Date(beirut))).toBe("2026-03-29");
  });

  it("tzWallClockIso builds a timed local instant", () => {
    expect(tzWallClockIso("2026-07-01", 14, 0, "America/Chicago")).toBe(
      "2026-07-01T14:00:00-05:00",
    );
  });

  it("addMinutesIso advances within the same offset", () => {
    expect(
      addMinutesIso("2026-07-01T14:00:00-05:00", 30, "America/Chicago"),
    ).toBe("2026-07-01T14:30:00-05:00");
  });

  it("parseClock validates HH:MM", () => {
    expect(parseClock("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(() => parseClock("25:00")).toThrow();
    expect(() => parseClock("noon")).toThrow();
  });
});
