import { describe, it, expect } from "vitest";
import { applyUntilToRRule } from "../event-write-fields.js";

// ---------------------------------------------------------------------------
// applyUntilToRRule
//
// Pure helper: takes an array of recurrence rules (mix of RRULE/EXDATE/etc.)
// and returns a new array with the FIRST RRULE updated to carry the given
// UNTIL stamp. Existing UNTIL is replaced; existing COUNT is dropped (Google
// rejects events with both UNTIL and COUNT). Non-RRULE entries pass through
// untouched. Empty input → array with a single bare RRULE? No — bail when
// there's no RRULE to anchor on so callers can surface a clear error.
// ---------------------------------------------------------------------------

describe("applyUntilToRRule", () => {
  it("inserts UNTIL into an RRULE that lacks it", () => {
    expect(
      applyUntilToRRule(["RRULE:FREQ=WEEKLY;BYDAY=MO"], "20260601T000000Z"),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z"]);
  });

  it("replaces an existing UNTIL on the RRULE", () => {
    expect(
      applyUntilToRRule(
        ["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20990101T000000Z"],
        "20260601T000000Z",
      ),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z"]);
  });

  it("drops COUNT when applying UNTIL (Google rejects both)", () => {
    expect(
      applyUntilToRRule(
        ["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO"],
        "20260601T000000Z",
      ),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z"]);
  });

  it("only touches the first RRULE and leaves other entries verbatim", () => {
    expect(
      applyUntilToRRule(
        [
          "EXDATE;TZID=America/Chicago:20260520T100000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO",
          "EXDATE:20260527T150000Z",
        ],
        "20260601T000000Z",
      ),
    ).toEqual([
      "EXDATE;TZID=America/Chicago:20260520T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z",
      "EXDATE:20260527T150000Z",
    ]);
  });

  it("throws when no RRULE is present (caller surfaces a clear error)", () => {
    expect(() =>
      applyUntilToRRule(["EXDATE:20260527T150000Z"], "20260601T000000Z"),
    ).toThrow(/RRULE/);
  });

  it("throws on an empty rules array", () => {
    expect(() => applyUntilToRRule([], "20260601T000000Z")).toThrow(/RRULE/);
  });
});
