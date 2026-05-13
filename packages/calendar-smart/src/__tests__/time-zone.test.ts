import { describe, it, expect } from "vitest";
import {
  startOfDay,
  endOfDay,
  weekBounds,
  formatIso,
  todayInTz,
} from "../time-zone.js";

// All tests use `Intl.DateTimeFormat` under the hood; they assume the test
// runner has full ICU data (Node 22 default builds do). If a future Node
// release switches to small-icu, these tests will fail loudly rather than
// silently produce UTC-equivalent results.

describe("startOfDay", () => {
  it("returns midnight UTC for a UTC date string", () => {
    const out = startOfDay("2026-05-13", "UTC");
    expect(out.toISOString()).toBe("2026-05-13T00:00:00.000Z");
  });

  it("returns 05:00 UTC for America/Chicago on a CDT day (UTC-5)", () => {
    // 2026-05-13 in Chicago is CDT (UTC-5); midnight local = 05:00 UTC.
    const out = startOfDay("2026-05-13", "America/Chicago");
    expect(out.toISOString()).toBe("2026-05-13T05:00:00.000Z");
  });

  it("returns 06:00 UTC for America/Chicago on a CST day (UTC-6)", () => {
    // 2026-01-15 is CST (no DST); midnight local = 06:00 UTC.
    const out = startOfDay("2026-01-15", "America/Chicago");
    expect(out.toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });

  it("returns 18:00 prev-day UTC for Asia/Dhaka (UTC+6)", () => {
    // Dhaka is UTC+6 year-round; midnight local = 18:00 prev day UTC.
    const out = startOfDay("2026-05-13", "Asia/Dhaka");
    expect(out.toISOString()).toBe("2026-05-12T18:00:00.000Z");
  });

  it("accepts a Date input and resolves the local-tz day around it", () => {
    // 2026-05-13T10:00:00-05:00 (CDT) → still 2026-05-13 in Chicago.
    const ref = new Date("2026-05-13T15:00:00.000Z");
    const out = startOfDay(ref, "America/Chicago");
    expect(out.toISOString()).toBe("2026-05-13T05:00:00.000Z");
  });

  it("handles late-day UTC instants that are 'tomorrow' in Dhaka", () => {
    // 2026-05-12T19:30 UTC → 2026-05-13 01:30 in Dhaka.
    const ref = new Date("2026-05-12T19:30:00.000Z");
    const out = startOfDay(ref, "Asia/Dhaka");
    expect(out.toISOString()).toBe("2026-05-12T18:00:00.000Z");
  });

  it("handles Chicago spring-forward day (2026-03-08): midnight before the gap", () => {
    // On 2026-03-08, Chicago jumps from 02:00 CST to 03:00 CDT.
    // Midnight local on 2026-03-08 is still CST (UTC-6) → 06:00 UTC.
    const out = startOfDay("2026-03-08", "America/Chicago");
    expect(out.toISOString()).toBe("2026-03-08T06:00:00.000Z");
  });

  it("handles Chicago fall-back day (2026-11-01): midnight before the repeat", () => {
    // On 2026-11-01, Chicago goes 02:00 CDT → 01:00 CST.
    // Midnight local is CDT (UTC-5) → 05:00 UTC.
    const out = startOfDay("2026-11-01", "America/Chicago");
    expect(out.toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });
});

describe("endOfDay", () => {
  it("returns midnight of the next UTC day for UTC", () => {
    const out = endOfDay("2026-05-13", "UTC");
    expect(out.toISOString()).toBe("2026-05-14T00:00:00.000Z");
  });

  it("returns 05:00 UTC of next day for Chicago in CDT", () => {
    const out = endOfDay("2026-05-13", "America/Chicago");
    expect(out.toISOString()).toBe("2026-05-14T05:00:00.000Z");
  });

  it("returns 18:00 UTC of same day for Dhaka", () => {
    const out = endOfDay("2026-05-13", "Asia/Dhaka");
    expect(out.toISOString()).toBe("2026-05-13T18:00:00.000Z");
  });

  it("spring-forward Chicago: end-of-day is 23h after start (one hour lost)", () => {
    // 2026-03-08 in Chicago: midnight CST (06:00 UTC) → next midnight CDT (05:00 UTC).
    // Span = 23 hours.
    const start = startOfDay("2026-03-08", "America/Chicago");
    const end = endOfDay("2026-03-08", "America/Chicago");
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it("fall-back Chicago: end-of-day is 25h after start (one hour gained)", () => {
    // 2026-11-01 in Chicago: midnight CDT (05:00 UTC) → next midnight CST (06:00 UTC).
    // Span = 25 hours.
    const start = startOfDay("2026-11-01", "America/Chicago");
    const end = endOfDay("2026-11-01", "America/Chicago");
    expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });
});

describe("weekBounds — Monday-based", () => {
  it("Wednesday 2026-05-13 → Mon 2026-05-11 to Mon 2026-05-18 (Chicago)", () => {
    const { start, end } = weekBounds("2026-05-13", "America/Chicago");
    expect(start.toISOString()).toBe("2026-05-11T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-18T05:00:00.000Z");
  });

  it("Monday 2026-05-11 → start is the same day", () => {
    const { start, end } = weekBounds("2026-05-11", "America/Chicago");
    expect(start.toISOString()).toBe("2026-05-11T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-18T05:00:00.000Z");
  });

  it("Sunday 2026-05-17 → start is Mon 2026-05-11 (Sunday is end-of-week)", () => {
    const { start, end } = weekBounds("2026-05-17", "America/Chicago");
    expect(start.toISOString()).toBe("2026-05-11T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-18T05:00:00.000Z");
  });

  it("Tuesday 2026-05-12 in Dhaka → Mon 2026-05-11 to Mon 2026-05-18", () => {
    const { start, end } = weekBounds("2026-05-12", "Asia/Dhaka");
    expect(start.toISOString()).toBe("2026-05-10T18:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-17T18:00:00.000Z");
  });

  it("UTC week: Wed 2026-05-13 → Mon 2026-05-11 to Mon 2026-05-18", () => {
    const { start, end } = weekBounds("2026-05-13", "UTC");
    expect(start.toISOString()).toBe("2026-05-11T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-18T00:00:00.000Z");
  });
});

describe("formatIso", () => {
  it("formats a Date in UTC as ...Z-ish offset", () => {
    const d = new Date("2026-05-13T15:00:00.000Z");
    // UTC formats as +00:00
    expect(formatIso(d, "UTC")).toBe("2026-05-13T15:00:00+00:00");
  });

  it("formats in America/Chicago with -05:00 offset (CDT)", () => {
    const d = new Date("2026-05-13T15:00:00.000Z");
    expect(formatIso(d, "America/Chicago")).toBe("2026-05-13T10:00:00-05:00");
  });

  it("formats in America/Chicago with -06:00 offset (CST winter)", () => {
    const d = new Date("2026-01-15T15:00:00.000Z");
    expect(formatIso(d, "America/Chicago")).toBe("2026-01-15T09:00:00-06:00");
  });

  it("formats in Asia/Dhaka with +06:00 offset", () => {
    const d = new Date("2026-05-13T15:00:00.000Z");
    expect(formatIso(d, "Asia/Dhaka")).toBe("2026-05-13T21:00:00+06:00");
  });

  it("rolls into next day when local time crosses midnight", () => {
    // 2026-05-12T19:30 UTC → Dhaka 2026-05-13 01:30
    const d = new Date("2026-05-12T19:30:00.000Z");
    expect(formatIso(d, "Asia/Dhaka")).toBe("2026-05-13T01:30:00+06:00");
  });
});

describe("todayInTz", () => {
  it("returns YYYY-MM-DD for the given reference Date in the given tz", () => {
    const ref = new Date("2026-05-13T15:00:00.000Z");
    expect(todayInTz("America/Chicago", ref)).toBe("2026-05-13");
  });

  it("returns next day in Asia/Dhaka when ref is late evening UTC", () => {
    const ref = new Date("2026-05-12T20:00:00.000Z"); // 02:00 next day in Dhaka
    expect(todayInTz("Asia/Dhaka", ref)).toBe("2026-05-13");
  });

  it("returns previous day in America/Chicago when ref is just past UTC midnight", () => {
    // 2026-05-13T03:00:00Z → Chicago 2026-05-12 22:00 (CDT)
    const ref = new Date("2026-05-13T03:00:00.000Z");
    expect(todayInTz("America/Chicago", ref)).toBe("2026-05-12");
  });

  it("UTC trivially returns the date portion of the ref", () => {
    const ref = new Date("2026-05-13T15:00:00.000Z");
    expect(todayInTz("UTC", ref)).toBe("2026-05-13");
  });

  it("defaults ref to now when omitted (smoke test for current date format)", () => {
    const out = todayInTz("UTC");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
