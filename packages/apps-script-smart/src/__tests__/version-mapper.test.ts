import { describe, it, expect } from "vitest";
import { mapVersion } from "../version-mapper.js";

describe("mapVersion", () => {
  it("maps the full Version resource", () => {
    expect(
      mapVersion({
        scriptId: "s1",
        versionNumber: 3,
        description: "release",
        createTime: "2026-06-30T12:00:00.000Z",
      }),
    ).toEqual({
      script_id: "s1",
      version_number: 3,
      description: "release",
      create_time: "2026-06-30T12:00:00.000Z",
    });
  });

  it("collapses absent fields to null", () => {
    expect(mapVersion({ scriptId: "s1", versionNumber: 1 })).toEqual({
      script_id: "s1",
      version_number: 1,
      description: null,
      create_time: null,
    });
  });
});
