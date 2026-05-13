// Pure busy/free window math. No I/O, no client dependency. The availability
// tools call this to invert Google's freeBusy response into the free-block
// shape the LLM consumes. Inputs are `Date` instances; the tool layer is
// responsible for serializing back to ISO strings with the correct tz offset.

/**
 * A half-open `[start, end)` busy window. End is exclusive — a 09:00–10:00
 * busy window does NOT collide with a 10:00–11:00 busy window for the
 * purpose of merging or free-block computation.
 */
export type BusyWindow = {
  start: Date;
  end: Date;
};

/**
 * A free block found by `findFreeBlocks`. `durationMinutes` is the width of
 * the block in whole minutes, computed by truncation (floor of ms / 60_000)
 * so a 30-minute gap reports as exactly 30, never 29 or 30.something.
 */
export type FreeBlock = {
  start: Date;
  end: Date;
  durationMinutes: number;
};

/**
 * Merge overlapping or adjacent (touching) busy windows. The result is
 * sorted by `start`. Empty input returns `[]`. The input array is not
 * mutated; merging works on a sorted copy.
 *
 * Two windows are considered mergeable when `next.start <= current.end`
 * (touching counts), matching the standard interval-merge sweep.
 */
export function mergeBusy(windows: BusyWindow[]): BusyWindow[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const out: BusyWindow[] = [];
  // Non-null assertion is safe — sorted.length >= 1 here.
  let cur: BusyWindow = {
    start: sorted[0]!.start,
    end: sorted[0]!.end,
  };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start.getTime() <= cur.end.getTime()) {
      // Overlap or touch — extend the current run.
      if (next.end.getTime() > cur.end.getTime()) {
        cur = { start: cur.start, end: next.end };
      }
    } else {
      out.push(cur);
      cur = { start: next.start, end: next.end };
    }
  }
  out.push(cur);
  return out;
}

/**
 * Invert busy windows within `[rangeStart, rangeEnd]` to surface the free
 * blocks of at least `minDurationMinutes`. Busy windows are clipped to the
 * range first, so windows that start before `rangeStart` or extend past
 * `rangeEnd` only consume the portion that falls inside the range.
 *
 * Returns `[]` if the range is empty (`rangeEnd <= rangeStart`) or if the
 * busy windows fully cover the range. Free blocks shorter than
 * `minDurationMinutes` are dropped.
 */
export function findFreeBlocks(
  windows: BusyWindow[],
  rangeStart: Date,
  rangeEnd: Date,
  minDurationMinutes: number,
): FreeBlock[] {
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  if (endMs <= startMs) return [];

  // Clip every busy window to the range, drop those entirely outside.
  const clipped: BusyWindow[] = [];
  for (const w of windows) {
    const ws = Math.max(w.start.getTime(), startMs);
    const we = Math.min(w.end.getTime(), endMs);
    if (we > ws) clipped.push({ start: new Date(ws), end: new Date(we) });
  }

  const merged = mergeBusy(clipped);

  // Sweep through merged busy windows, emitting the free gaps in between.
  const out: FreeBlock[] = [];
  let cursorMs = startMs;
  for (const busy of merged) {
    const bs = busy.start.getTime();
    const be = busy.end.getTime();
    if (bs > cursorMs) {
      pushIfLongEnough(out, cursorMs, bs, minDurationMinutes);
    }
    if (be > cursorMs) cursorMs = be;
  }
  if (cursorMs < endMs) {
    pushIfLongEnough(out, cursorMs, endMs, minDurationMinutes);
  }
  return out;
}

function pushIfLongEnough(
  out: FreeBlock[],
  startMs: number,
  endMs: number,
  minDurationMinutes: number,
): void {
  const durationMinutes = Math.floor((endMs - startMs) / 60_000);
  if (durationMinutes >= minDurationMinutes) {
    out.push({
      start: new Date(startMs),
      end: new Date(endMs),
      durationMinutes,
    });
  }
}
