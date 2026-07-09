import { describe, it, expect, vi } from "vitest";
import { getMetricsTool } from "../metrics.js";

// Default account the context resolves to when a call omits `account`.
const ACCT = "acct";

function ctxOf(
  getMetrics: ReturnType<typeof vi.fn>,
): { client: never; defaultAccount: string } {
  return { client: { getMetrics } as unknown as never, defaultAccount: ACCT };
}

describe("getMetricsTool", () => {
  it("defaults granularity to DAILY and omits deploymentId when unset", async () => {
    const getMetrics = vi.fn().mockResolvedValue({});
    const input = getMetricsTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof getMetricsTool.handler>[0];
    await getMetricsTool.handler(input, ctxOf(getMetrics));
    expect(getMetrics).toHaveBeenCalledWith(ACCT, {
      scriptId: "s1",
      metricsGranularity: "DAILY",
    });
  });

  it("forwards WEEKLY granularity + deployment_id and maps the result", async () => {
    const getMetrics = vi.fn().mockResolvedValue({
      totalExecutions: [
        { value: "9", startTime: "a", endTime: "b" },
      ],
    });
    const input = getMetricsTool.inputSchema.parse({
      script_id: "s1",
      granularity: "WEEKLY",
      deployment_id: "dep_1",
    }) as Parameters<typeof getMetricsTool.handler>[0];
    const out = await getMetricsTool.handler(input, ctxOf(getMetrics));
    expect(getMetrics).toHaveBeenCalledWith(ACCT, {
      scriptId: "s1",
      metricsGranularity: "WEEKLY",
      deploymentId: "dep_1",
    });
    expect(out.metrics.total_executions).toEqual([
      { value: "9", start_time: "a", end_time: "b" },
    ]);
  });
});
