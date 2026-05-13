import { describe, it, expect } from "vitest";
import { mergeBusy, findFreeBlocks, type BusyWindow } from "../free-busy.js";

// Helpers — all times anchored to 2026-05-13 in UTC for deterministic math.
function t(hhmm: string): Date {
  const [h, m] = hhmm.split(":");
  return new Date(`2026-05-13T${h}:${m}:00.000Z`);
}

function w(start: string, end: string): BusyWindow {
  return { start: t(start), end: t(end) };
}

describe("mergeBusy", () => {
  it("returns [] for empty input", () => {
    expect(mergeBusy([])).toEqual([]);
  });

  it("returns a single window unchanged", () => {
    const out = mergeBusy([w("09:00", "10:00")]);
    expect(out).toEqual([w("09:00", "10:00")]);
  });

  it("sorts windows by start time", () => {
    const out = mergeBusy([w("11:00", "12:00"), w("09:00", "10:00")]);
    expect(out).toEqual([w("09:00", "10:00"), w("11:00", "12:00")]);
  });

  it("merges overlapping windows into one", () => {
    const out = mergeBusy([w("09:00", "10:30"), w("10:00", "11:00")]);
    expect(out).toEqual([w("09:00", "11:00")]);
  });

  it("merges adjacent (touching) windows into one", () => {
    const out = mergeBusy([w("09:00", "10:00"), w("10:00", "11:00")]);
    expect(out).toEqual([w("09:00", "11:00")]);
  });

  it("keeps disjoint windows separate", () => {
    const out = mergeBusy([w("09:00", "10:00"), w("11:00", "12:00")]);
    expect(out).toEqual([w("09:00", "10:00"), w("11:00", "12:00")]);
  });

  it("merges a chain of overlapping windows", () => {
    const out = mergeBusy([
      w("09:00", "10:00"),
      w("09:30", "10:30"),
      w("10:15", "11:00"),
    ]);
    expect(out).toEqual([w("09:00", "11:00")]);
  });

  it("handles a window fully contained inside another", () => {
    const out = mergeBusy([w("09:00", "12:00"), w("10:00", "11:00")]);
    expect(out).toEqual([w("09:00", "12:00")]);
  });

  it("does not mutate the input array", () => {
    const input: BusyWindow[] = [
      w("11:00", "12:00"),
      w("09:00", "10:00"),
    ];
    const snapshot = input.map((b) => ({ start: b.start, end: b.end }));
    mergeBusy(input);
    expect(input).toEqual(snapshot);
  });
});

describe("findFreeBlocks", () => {
  const RANGE_START = t("09:00");
  const RANGE_END = t("17:00");

  it("returns one big free block for empty busy windows", () => {
    const out = findFreeBlocks([], RANGE_START, RANGE_END, 15);
    expect(out).toEqual([
      {
        start: RANGE_START,
        end: RANGE_END,
        durationMinutes: 8 * 60,
      },
    ]);
  });

  it("returns [] when one busy window fully covers the range", () => {
    const out = findFreeBlocks(
      [w("08:00", "18:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([]);
  });

  it("returns [] when busy windows exactly cover the range", () => {
    const out = findFreeBlocks(
      [w("09:00", "12:00"), w("12:00", "17:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([]);
  });

  it("inverts a single mid-range busy window into two free blocks", () => {
    const out = findFreeBlocks(
      [w("11:00", "12:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("11:00"), durationMinutes: 120 },
      { start: t("12:00"), end: t("17:00"), durationMinutes: 300 },
    ]);
  });

  it("excludes back-to-back events (zero gap is not a free block)", () => {
    const out = findFreeBlocks(
      [w("10:00", "11:00"), w("11:00", "12:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("10:00"), durationMinutes: 60 },
      { start: t("12:00"), end: t("17:00"), durationMinutes: 300 },
    ]);
  });

  it("merges overlapping events before inverting", () => {
    const out = findFreeBlocks(
      [w("10:00", "11:30"), w("11:00", "12:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("10:00"), durationMinutes: 60 },
      { start: t("12:00"), end: t("17:00"), durationMinutes: 300 },
    ]);
  });

  it("clips a busy window that starts before the range start", () => {
    const out = findFreeBlocks(
      [w("08:00", "10:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("10:00"), end: t("17:00"), durationMinutes: 7 * 60 },
    ]);
  });

  it("clips a busy window that extends past the range end", () => {
    const out = findFreeBlocks(
      [w("16:00", "20:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("16:00"), durationMinutes: 7 * 60 },
    ]);
  });

  it("ignores busy windows entirely outside the range", () => {
    const out = findFreeBlocks(
      [w("06:00", "07:00"), w("19:00", "20:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: RANGE_START, end: RANGE_END, durationMinutes: 8 * 60 },
    ]);
  });

  it("filters free blocks shorter than minDurationMinutes", () => {
    const out = findFreeBlocks(
      [w("09:10", "09:50"), w("10:00", "17:00")],
      RANGE_START,
      RANGE_END,
      30,
    );
    // gap 09:00–09:10 (10m) and 09:50–10:00 (10m) both excluded.
    expect(out).toEqual([]);
  });

  it("keeps free blocks exactly equal to minDurationMinutes", () => {
    const out = findFreeBlocks(
      [w("09:30", "17:00")],
      RANGE_START,
      RANGE_END,
      30,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("09:30"), durationMinutes: 30 },
    ]);
  });

  it("rejects events that start before and extend past the entire range as fully booked", () => {
    const out = findFreeBlocks(
      [w("06:00", "23:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([]);
  });

  it("merges multi-calendar overlapping windows correctly", () => {
    // Calendar A 10:00-11:00, Calendar B 10:30-12:00 → free 09:00-10:00, 12:00-17:00.
    const out = findFreeBlocks(
      [w("10:00", "11:00"), w("10:30", "12:00")],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([
      { start: t("09:00"), end: t("10:00"), durationMinutes: 60 },
      { start: t("12:00"), end: t("17:00"), durationMinutes: 300 },
    ]);
  });

  it("returns [] when minDuration is larger than the entire range and no busy", () => {
    const out = findFreeBlocks([], RANGE_START, RANGE_END, 600);
    // Range is only 480 minutes wide.
    expect(out).toEqual([]);
  });

  it("returns [] when rangeStart >= rangeEnd", () => {
    expect(findFreeBlocks([], RANGE_END, RANGE_START, 15)).toEqual([]);
    expect(findFreeBlocks([], RANGE_START, RANGE_START, 15)).toEqual([]);
  });

  it("handles an all-day-style window spanning the entire range exactly", () => {
    const out = findFreeBlocks(
      [{ start: RANGE_START, end: RANGE_END }],
      RANGE_START,
      RANGE_END,
      15,
    );
    expect(out).toEqual([]);
  });

  it("does not mutate the input busy array", () => {
    const input: BusyWindow[] = [
      w("11:00", "12:00"),
      w("09:30", "10:00"),
    ];
    const snapshot = input.map((b) => ({ start: b.start, end: b.end }));
    findFreeBlocks(input, RANGE_START, RANGE_END, 15);
    expect(input).toEqual(snapshot);
  });
});
