import { describe, it, expect } from "vitest";
import { mapTaskList, type SlimTaskList } from "../tasklist-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimTaskList> = ["id", "title", "updated"];

describe("mapTaskList", () => {
  it("maps a full TaskList resource and strips kind/etag/selfLink", () => {
    const raw = {
      kind: "tasks#taskList",
      id: "list_alpha",
      etag: '"etag-value"',
      title: "Groceries",
      updated: "2026-06-29T10:00:00.000Z",
      selfLink: "https://tasks.googleapis.com/.../list_alpha",
    };
    const slim = mapTaskList(raw);
    expect(slim).toEqual({
      id: "list_alpha",
      title: "Groceries",
      updated: "2026-06-29T10:00:00.000Z",
    });
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });

  it("collapses missing id/title to empty strings and updated to null", () => {
    const slim = mapTaskList({});
    expect(slim).toEqual({ id: "", title: "", updated: null });
  });

  it("coerces a non-string updated to null", () => {
    const slim = mapTaskList({ id: "x", title: "y", updated: 12345 });
    expect(slim.updated).toBeNull();
  });

  it("throws on a non-object resource", () => {
    expect(() => mapTaskList(null)).toThrow(/expected an object/);
    expect(() => mapTaskList([])).toThrow(/expected an object/);
  });
});
