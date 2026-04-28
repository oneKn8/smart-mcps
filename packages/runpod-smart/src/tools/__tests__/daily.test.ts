import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { z } from "zod";
import { dailyStatus } from "../daily.js";

type FakeClient = {
  listPods: ReturnType<typeof vi.fn>;
  getBillingPods: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listPods: vi.fn().mockResolvedValue({ pods: [] }),
    getBillingPods: vi.fn().mockResolvedValue({ records: [] }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin "now" so window math is deterministic.
  vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dailyStatus — metadata", () => {
  it("has correct name and description", () => {
    expect(dailyStatus.name).toBe("daily_status");
    expect(dailyStatus.description).toBe(
      "Active pods + last 24h cost + flagged resources.",
    );
    expect(dailyStatus.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("dailyStatus — input schema", () => {
  it("defaults hours to 24 when omitted", () => {
    expect(dailyStatus.inputSchema.parse({}).hours).toBe(24);
  });

  it("accepts custom hours within 1..168", () => {
    expect(dailyStatus.inputSchema.parse({ hours: 1 }).hours).toBe(1);
    expect(dailyStatus.inputSchema.parse({ hours: 48 }).hours).toBe(48);
    expect(dailyStatus.inputSchema.parse({ hours: 168 }).hours).toBe(168);
  });

  it("rejects out-of-range hours", () => {
    expect(() => dailyStatus.inputSchema.parse({ hours: 0 })).toThrow();
    expect(() => dailyStatus.inputSchema.parse({ hours: 169 })).toThrow();
    expect(() => dailyStatus.inputSchema.parse({ hours: 1.5 })).toThrow();
  });
});

describe("dailyStatus — handler", () => {
  it("calls listPods with desiredStatus RUNNING and getBillingPods with the window", async () => {
    const client = makeClient();
    await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }),
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledWith({ desiredStatus: "RUNNING" });
    expect(client.getBillingPods).toHaveBeenCalledWith({
      from: "2026-04-26T12:00:00.000Z",
      to: "2026-04-27T12:00:00.000Z",
    });
  });

  it("uses a 12h window when hours=12", async () => {
    const client = makeClient();
    await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 12 }),
      { client: client as unknown as never },
    );
    expect(client.getBillingPods).toHaveBeenCalledWith({
      from: "2026-04-27T00:00:00.000Z",
      to: "2026-04-27T12:00:00.000Z",
    });
  });

  it("returns slim active pods through the shared mapPod shape", async () => {
    const client = makeClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          {
            id: "pod_a",
            name: "trainer",
            image: "runpod/pytorch:2.1.0",
            desiredStatus: "RUNNING",
            costPerHr: 0.74,
            adjustedCostPerHr: 0.69,
            gpu: { displayName: "RTX 4090" },
            gpuCount: 2,
            lastStartedAt: "2026-04-27T08:00:00.000Z",
            // Upstream extras the slim mapper must drop:
            env: { FOO: "bar" },
            ports: ["8888/http"],
          },
        ],
      }),
    });
    const result = await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }),
      { client: client as unknown as never },
    );
    expect(result.active_pods).toHaveLength(1);
    const slim = result.active_pods[0]!;
    expect(slim.id).toBe("pod_a");
    expect(slim.name).toBe("trainer");
    expect(slim.status).toBe("RUNNING");
    expect(slim.gpu).toEqual({ displayName: "RTX 4090", count: 2 });
    expect((slim as Record<string, unknown>).env).toBeUndefined();
    expect((slim as Record<string, unknown>).ports).toBeUndefined();
  });

  it("totals cost from billing records into total_cost_usd_window", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        records: [
          { amount: 1.5, podId: "pod_a" },
          { amount: 2.25, podId: "pod_b" },
          { amount: 0.5, podId: "pod_a" },
        ],
      }),
    });
    const result = await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }),
      { client: client as unknown as never },
    );
    expect(result.total_cost_usd_window).toBeCloseTo(4.25);
  });

  it("flags pods running longer than the window", async () => {
    // hours=24 → cutoff 2026-04-26T12:00Z. pod_old lastStartedAt is before
    // cutoff → flagged. pod_new is after cutoff → not flagged.
    const client = makeClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          {
            id: "pod_old",
            name: "long-runner",
            desiredStatus: "RUNNING",
            costPerHr: 0.5,
            adjustedCostPerHr: 0.5,
            lastStartedAt: "2026-04-20T12:00:00.000Z",
          },
          {
            id: "pod_new",
            name: "fresh",
            desiredStatus: "RUNNING",
            costPerHr: 0.5,
            adjustedCostPerHr: 0.5,
            lastStartedAt: "2026-04-27T08:00:00.000Z",
          },
        ],
      }),
    });
    const result = await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }),
      { client: client as unknown as never },
    );
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]?.pod_id).toBe("pod_old");
    expect(result.flagged[0]?.reason).toContain("24");
  });

  it("does not flag pods with missing lastStartedAt", async () => {
    const client = makeClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          {
            id: "pod_unknown_start",
            desiredStatus: "RUNNING",
            costPerHr: 0.5,
            adjustedCostPerHr: 0.5,
          },
        ],
      }),
    });
    const result = await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }),
      { client: client as unknown as never },
    );
    expect(result.flagged).toEqual([]);
  });

  it("returns window_hours echoing the input", async () => {
    const client = makeClient();
    const result = await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 48 }),
      { client: client as unknown as never },
    );
    expect(result.window_hours).toBe(48);
  });
});
