import { describe, it, expect } from "vitest";
import {
  clamp,
  dueDateOnly,
  eventTimeLabel,
  firstThreadMessage,
  mdInline,
  messageFrom,
  messageSnippet,
  messageSubject,
  oneLine,
  readEvent,
  readTask,
  toDueTimestamp,
} from "../extract.js";

const MSG = {
  snippet: "hello there",
  payload: {
    headers: [
      { name: "Subject", value: "Weekly sync" },
      { name: "From", value: "Bob <bob@example.com>" },
    ],
  },
};

describe("gmail extractors", () => {
  it("reads subject/from/snippet, case-insensitive headers", () => {
    expect(messageSubject(MSG)).toBe("Weekly sync");
    expect(messageFrom(MSG)).toBe("Bob <bob@example.com>");
    expect(messageSnippet(MSG)).toBe("hello there");
  });

  it("returns null for missing pieces", () => {
    expect(messageSubject({})).toBeNull();
    expect(messageSubject(null)).toBeNull();
    expect(messageSnippet({ payload: {} })).toBeNull();
  });

  it("firstThreadMessage picks the first message or null", () => {
    expect(firstThreadMessage({ messages: [MSG, {}] })).toBe(MSG);
    expect(firstThreadMessage({ messages: [] })).toBeNull();
    expect(firstThreadMessage({})).toBeNull();
  });
});

describe("task extractor", () => {
  it("reads slim fields and normalizes due to date-only", () => {
    const t = readTask({
      id: "t1",
      title: "Do thing",
      notes: "n",
      status: "needsAction",
      due: "2026-07-01T00:00:00.000Z",
    });
    expect(t).toEqual({
      id: "t1",
      title: "Do thing",
      notes: "n",
      status: "needsAction",
      due: "2026-07-01",
      completed: null,
      deleted: false,
    });
  });

  it("dueDateOnly / toDueTimestamp round-trip the write path", () => {
    expect(dueDateOnly("2026-07-01T00:00:00.000Z")).toBe("2026-07-01");
    expect(dueDateOnly(undefined)).toBeNull();
    expect(toDueTimestamp("2026-07-01")).toBe("2026-07-01T00:00:00.000Z");
    expect(toDueTimestamp("already-passthrough")).toBe("already-passthrough");
  });
});

describe("event extractor", () => {
  it("reads timed events", () => {
    const e = readEvent({
      id: "e1",
      summary: "Standup",
      start: { dateTime: "2026-07-01T09:00:00-05:00" },
      end: { dateTime: "2026-07-01T09:15:00-05:00" },
      htmlLink: "http://x",
    });
    expect(e.allDay).toBe(false);
    expect(e.start).toBe("2026-07-01T09:00:00-05:00");
    expect(eventTimeLabel(e)).toBe("09:00");
  });

  it("reads all-day events and labels them", () => {
    const e = readEvent({ id: "e2", summary: "Holiday", start: { date: "2026-07-04" } });
    expect(e.allDay).toBe(true);
    expect(eventTimeLabel(e)).toBe("all-day");
  });

  it("defaults a missing summary", () => {
    expect(readEvent({ id: "e3" }).summary).toBe("(no title)");
  });
});

describe("markdown helpers", () => {
  it("oneLine collapses whitespace", () => {
    expect(oneLine("a\n  b\tc ")).toBe("a b c");
  });

  it("mdInline neutralizes emphasis/pipe/heading markers", () => {
    expect(mdInline("**bold** | # x")).toBe("\\*\\*bold\\*\\* \\| \\# x");
  });

  it("clamp truncates with an ellipsis", () => {
    expect(clamp("hello world", 100)).toBe("hello world");
    expect(clamp("hello world", 6)).toBe("hello…");
  });
});
