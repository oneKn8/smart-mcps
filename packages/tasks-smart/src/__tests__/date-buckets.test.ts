import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  localDateKey,
  addDaysToDateKey,
  dateKeyToUtcMidnight,
} from "../date-buckets.js";

let savedTz: string | undefined;

beforeEach(() => {
  savedTz = process.env.TZ;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("localDateKey — system-local date", () => {
  // The instant 2026-06-30T20:00:00Z is still June 30 in Chicago (UTC-5) but
  // already July 1 in Dhaka (UTC+6). localDateKey must follow the host zone.
  const EDGE = new Date("2026-06-30T20:00:00.000Z");

  it("returns the LOCAL date, not the UTC date (Asia/Dhaka => next day)", () => {
    process.env.TZ = "Asia/Dhaka";
    vi.setSystemTime(EDGE);
    expect(localDateKey()).toBe("2026-07-01");
  });

  it("returns the LOCAL date for a behind-UTC zone (America/Chicago)", () => {
    process.env.TZ = "America/Chicago";
    vi.setSystemTime(EDGE);
    expect(localDateKey()).toBe("2026-06-30");
  });

  it("computes the local date of an explicit ref instant", () => {
    process.env.TZ = "UTC";
    expect(localDateKey(new Date("2026-01-15T03:00:00.000Z"))).toBe(
      "2026-01-15",
    );
  });
});

describe("addDaysToDateKey", () => {
  it("adds a day with month rollover", () => {
    expect(addDaysToDateKey("2026-06-30", 1)).toBe("2026-07-01");
  });
  it("subtracts a day with month/year rollover", () => {
    expect(addDaysToDateKey("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("rejects a malformed key", () => {
    expect(() => addDaysToDateKey("2026/06/30", 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe("dateKeyToUtcMidnight", () => {
  it("appends UTC midnight", () => {
    expect(dateKeyToUtcMidnight("2026-06-30")).toBe("2026-06-30T00:00:00.000Z");
  });
});
