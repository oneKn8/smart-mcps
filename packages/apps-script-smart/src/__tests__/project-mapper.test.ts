import { describe, it, expect } from "vitest";
import { mapProject } from "../project-mapper.js";

describe("mapProject", () => {
  it("maps the full Project resource to the slim snake_case shape", () => {
    const raw = {
      scriptId: "script_abc",
      title: "My Project",
      parentId: "doc_123",
      createTime: "2026-06-30T12:00:00.000Z",
      updateTime: "2026-06-30T13:00:00.000Z",
      creator: { email: "santo@example.test", name: "Santo" },
      lastModifyUser: { email: "santo@example.test" },
      kind: "ignored",
    };
    expect(mapProject(raw)).toEqual({
      script_id: "script_abc",
      title: "My Project",
      parent_id: "doc_123",
      create_time: "2026-06-30T12:00:00.000Z",
      update_time: "2026-06-30T13:00:00.000Z",
      creator: "santo@example.test",
      last_modify_user: "santo@example.test",
    });
  });

  it("collapses missing optional fields to null and standalone parent to null", () => {
    const out = mapProject({ scriptId: "s1", title: "Standalone" });
    expect(out).toEqual({
      script_id: "s1",
      title: "Standalone",
      parent_id: null,
      create_time: null,
      update_time: null,
      creator: null,
      last_modify_user: null,
    });
  });

  it("strips upstream extras (no kind/etag leak)", () => {
    const out = mapProject({ scriptId: "s1", title: "T", kind: "x", etag: "y" });
    expect(Object.keys(out).sort()).toEqual(
      [
        "create_time",
        "creator",
        "last_modify_user",
        "parent_id",
        "script_id",
        "title",
        "update_time",
      ].sort(),
    );
  });

  it("throws on a non-object input", () => {
    expect(() => mapProject(null)).toThrow();
  });
});
