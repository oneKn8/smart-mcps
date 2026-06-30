import { describe, it, expect } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  mapTask,
  dueDateOnly,
  toDueTimestamp,
  type SlimTask,
} from "../task-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimTask> = [
  "id",
  "title",
  "notes",
  "status",
  "due",
  "completed",
  "parent",
  "deleted",
  "hidden",
  "web_view_link",
];

describe("mapTask — shape + stripping", () => {
  it("maps a full Task resource and strips kind/etag/selfLink/position/links", () => {
    const raw = {
      kind: "tasks#task",
      id: "task_alpha",
      etag: '"etag"',
      title: "Buy milk",
      updated: "2026-06-29T10:00:00.000Z",
      selfLink: "https://tasks.googleapis.com/.../task_alpha",
      parent: "task_parent",
      position: "00000000000000000001",
      notes: "2% organic",
      status: "needsAction",
      due: "2026-06-30T00:00:00.000Z",
      webViewLink: "https://tasks.google.com/task/task_alpha",
      links: [{ type: "email", description: "src", link: "https://x" }],
    };
    const slim = mapTask(raw);
    expect(slim).toEqual({
      id: "task_alpha",
      title: "Buy milk",
      notes: "2% organic",
      status: "needsAction",
      due: "2026-06-30",
      completed: null,
      parent: "task_parent",
      deleted: false,
      hidden: false,
      web_view_link: "https://tasks.google.com/task/task_alpha",
    });
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });

  it("normalizes due to a bare YYYY-MM-DD date (no time-of-day surfaced)", () => {
    const slim = mapTask({ id: "t", title: "x", due: "2026-12-25T00:00:00Z" });
    expect(slim.due).toBe("2026-12-25");
    expect(slim.due).not.toContain("T");
  });

  it("returns null due when absent or non-string", () => {
    expect(mapTask({ id: "t", title: "x" }).due).toBeNull();
    expect(mapTask({ id: "t", title: "x", due: 5 }).due).toBeNull();
  });

  it("surfaces a real completed timestamp and completed status", () => {
    const slim = mapTask({
      id: "t",
      title: "x",
      status: "completed",
      completed: "2026-06-29T14:32:00.000Z",
    });
    expect(slim.status).toBe("completed");
    expect(slim.completed).toBe("2026-06-29T14:32:00.000Z");
  });

  it("defaults an unknown status to needsAction", () => {
    expect(mapTask({ id: "t", title: "x", status: "weird" }).status).toBe(
      "needsAction",
    );
    expect(mapTask({ id: "t", title: "x" }).status).toBe("needsAction");
  });

  it("reads deleted/hidden booleans, defaulting to false", () => {
    const slim = mapTask({ id: "t", title: "x", deleted: true, hidden: true });
    expect(slim.deleted).toBe(true);
    expect(slim.hidden).toBe(true);
    const def = mapTask({ id: "t", title: "x" });
    expect(def.deleted).toBe(false);
    expect(def.hidden).toBe(false);
  });

  it("throws on a non-object resource", () => {
    expect(() => mapTask(null)).toThrow(/expected an object/);
  });
});

describe("dueDateOnly", () => {
  it("extracts the calendar date from a full timestamp", () => {
    expect(dueDateOnly("2026-06-30T00:00:00.000Z")).toBe("2026-06-30");
  });
  it("passes through a bare date", () => {
    expect(dueDateOnly("2026-06-30")).toBe("2026-06-30");
  });
  it("returns null for non-strings / non-dates", () => {
    expect(dueDateOnly(42)).toBeNull();
    expect(dueDateOnly("not-a-date")).toBeNull();
    expect(dueDateOnly(undefined)).toBeNull();
  });
});

describe("toDueTimestamp", () => {
  it("expands a bare YYYY-MM-DD to UTC midnight", () => {
    expect(toDueTimestamp("2026-06-30")).toBe("2026-06-30T00:00:00.000Z");
  });
  it("forwards a full timestamp verbatim", () => {
    expect(toDueTimestamp("2026-06-30T09:00:00.000Z")).toBe(
      "2026-06-30T09:00:00.000Z",
    );
  });
  it("accepts a real leap day", () => {
    expect(toDueTimestamp("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
  });
  it("rejects a well-formed but impossible calendar date", () => {
    // Right shape, wrong reality: bad month, bad day, or a non-existent
    // day-of-month must throw locally rather than 400 opaquely at the API.
    for (const bad of [
      "2026-13-45",
      "2026-00-10",
      "2026-02-30",
      "2026-04-31",
      "2026-01-32",
      "2026-02-29",
    ]) {
      expect(() => toDueTimestamp(bad)).toThrow(ValidationError);
    }
  });
});
