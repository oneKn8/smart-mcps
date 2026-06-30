import { describe, it, expect } from "vitest";
import { mapMetrics } from "../metrics-mapper.js";

describe("mapMetrics", () => {
  it("maps the three parallel series with snake_case values", () => {
    expect(
      mapMetrics({
        activeUsers: [
          {
            value: "5",
            startTime: "2026-06-23T00:00:00Z",
            endTime: "2026-06-30T00:00:00Z",
          },
        ],
        totalExecutions: [
          {
            value: "42",
            startTime: "2026-06-23T00:00:00Z",
            endTime: "2026-06-30T00:00:00Z",
          },
        ],
        failedExecutions: [],
      }),
    ).toEqual({
      active_users: [
        {
          value: "5",
          start_time: "2026-06-23T00:00:00Z",
          end_time: "2026-06-30T00:00:00Z",
        },
      ],
      total_executions: [
        {
          value: "42",
          start_time: "2026-06-23T00:00:00Z",
          end_time: "2026-06-30T00:00:00Z",
        },
      ],
      failed_executions: [],
    });
  });

  it("normalizes missing series to empty arrays", () => {
    expect(mapMetrics({})).toEqual({
      active_users: [],
      total_executions: [],
      failed_executions: [],
    });
  });
});
