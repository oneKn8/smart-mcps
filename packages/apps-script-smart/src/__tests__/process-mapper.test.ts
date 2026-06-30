import { describe, it, expect } from "vitest";
import { mapProcess } from "../process-mapper.js";

describe("mapProcess", () => {
  it("maps the full Process resource to snake_case", () => {
    expect(
      mapProcess({
        projectName: "Inbox Watcher",
        functionName: "poll",
        processType: "TIME_DRIVEN",
        processStatus: "COMPLETED",
        userAccessLevel: "OWNER",
        startTime: "2026-06-30T12:00:00.000Z",
        duration: "3.5s",
        runtimeVersion: "V8",
      }),
    ).toEqual({
      project_name: "Inbox Watcher",
      function_name: "poll",
      process_type: "TIME_DRIVEN",
      process_status: "COMPLETED",
      user_access_level: "OWNER",
      start_time: "2026-06-30T12:00:00.000Z",
      duration: "3.5s",
      runtime_version: "V8",
    });
  });

  it("collapses absent fields to null", () => {
    expect(mapProcess({ functionName: "f" })).toEqual({
      project_name: null,
      function_name: "f",
      process_type: null,
      process_status: null,
      user_access_level: null,
      start_time: null,
      duration: null,
      runtime_version: null,
    });
  });
});
