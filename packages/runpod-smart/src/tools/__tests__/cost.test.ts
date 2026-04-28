import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { z } from "zod";
import { costAudit } from "../cost.js";

type FakeClient = {
  getBillingPods: ReturnType<typeof vi.fn>;
  getBillingEndpoints: ReturnType<typeof vi.fn>;
  getBillingNetworkVolumes: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getBillingPods: vi.fn().mockResolvedValue({ records: [] }),
    getBillingEndpoints: vi.fn().mockResolvedValue({ records: [] }),
    getBillingNetworkVolumes: vi.fn().mockResolvedValue({ records: [] }),
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

describe("costAudit — metadata", () => {
  it("has correct name and description", () => {
    expect(costAudit.name).toBe("cost_audit");
    expect(costAudit.description).toBe(
      "Spend snapshot for pods, serverless, and storage in window.",
    );
    expect(costAudit.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("costAudit — input schema", () => {
  it("defaults days to 7 when omitted", () => {
    const parsed = costAudit.inputSchema.parse({});
    expect(parsed.days).toBe(7);
  });

  it("accepts custom days within 1..365", () => {
    expect(costAudit.inputSchema.parse({ days: 1 }).days).toBe(1);
    expect(costAudit.inputSchema.parse({ days: 30 }).days).toBe(30);
    expect(costAudit.inputSchema.parse({ days: 365 }).days).toBe(365);
  });

  it("rejects out-of-range or non-integer days", () => {
    expect(() => costAudit.inputSchema.parse({ days: 0 })).toThrow();
    expect(() => costAudit.inputSchema.parse({ days: 366 })).toThrow();
    expect(() => costAudit.inputSchema.parse({ days: 1.5 })).toThrow();
    expect(() => costAudit.inputSchema.parse({ days: -1 })).toThrow();
  });
});

describe("costAudit — handler", () => {
  it("calls all three billing methods with the same ISO from/to window", async () => {
    const client = makeClient();
    await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    // 2026-04-27T12:00Z minus 7 days = 2026-04-20T12:00Z
    const expected = {
      from: "2026-04-20T12:00:00.000Z",
      to: "2026-04-27T12:00:00.000Z",
    };
    expect(client.getBillingPods).toHaveBeenCalledWith(expected);
    expect(client.getBillingEndpoints).toHaveBeenCalledWith(expected);
    expect(client.getBillingNetworkVolumes).toHaveBeenCalledWith(expected);
  });

  it("uses days=1 for a 24h window", async () => {
    const client = makeClient();
    await costAudit.handler(
      costAudit.inputSchema.parse({ days: 1 }),
      { client: client as unknown as never },
    );
    expect(client.getBillingPods).toHaveBeenCalledWith({
      from: "2026-04-26T12:00:00.000Z",
      to: "2026-04-27T12:00:00.000Z",
    });
  });

  it("aggregates total_usd as sum of all three resource categories", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        records: [
          { amount: 10, podId: "p1" },
          { amount: 5, podId: "p2" },
        ],
      }),
      getBillingEndpoints: vi.fn().mockResolvedValue({
        records: [{ amount: 3, endpointId: "ep1" }],
      }),
      getBillingNetworkVolumes: vi.fn().mockResolvedValue({
        records: [{ amount: 2 }],
      }),
    });
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(result.window_days).toBe(7);
    expect(result.by_resource.pods).toBeCloseTo(15);
    expect(result.by_resource.endpoints).toBeCloseTo(3);
    expect(result.by_resource.networkvolumes).toBeCloseTo(2);
    expect(result.total_usd).toBeCloseTo(20);
  });

  it("returns top_pods sorted descending by cost, summing per-pod records", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        records: [
          { amount: 4, podId: "p_low", time: "2026-04-25T00:00:00Z" },
          { amount: 12, podId: "p_high", time: "2026-04-26T00:00:00Z" },
          { amount: 3, podId: "p_high", time: "2026-04-25T00:00:00Z" },
          { amount: 7, podId: "p_mid", time: "2026-04-26T00:00:00Z" },
        ],
      }),
    });
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(result.top_pods).toHaveLength(3);
    expect(result.top_pods[0]?.pod_id).toBe("p_high");
    expect(result.top_pods[0]?.cost_usd).toBeCloseTo(15);
    expect(result.top_pods[1]?.pod_id).toBe("p_mid");
    expect(result.top_pods[1]?.cost_usd).toBeCloseTo(7);
    expect(result.top_pods[2]?.pod_id).toBe("p_low");
    expect(result.top_pods[2]?.cost_usd).toBeCloseTo(4);
  });

  it("caps top_pods at 5 entries even when more pods are billed", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        records: [
          { amount: 1, podId: "a" },
          { amount: 2, podId: "b" },
          { amount: 3, podId: "c" },
          { amount: 4, podId: "d" },
          { amount: 5, podId: "e" },
          { amount: 6, podId: "f" },
          { amount: 7, podId: "g" },
        ],
      }),
    });
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(result.top_pods).toHaveLength(5);
    expect(result.top_pods.map((p) => p.pod_id)).toEqual([
      "g",
      "f",
      "e",
      "d",
      "c",
    ]);
  });

  it("returns empty top_pods + a note when no per-pod breakdown is available", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        // Aggregate-only records (grouping=gpuTypeId means no podId).
        records: [
          { amount: 50, gpuTypeId: "NVIDIA RTX A6000" },
          { amount: 20, gpuTypeId: "NVIDIA H100 PCIe" },
        ],
      }),
    });
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(result.top_pods).toEqual([]);
    expect(result.notes.some((n) => n.toLowerCase().includes("per-pod"))).toBe(
      true,
    );
  });

  it("emits a 'no spend' note when total is zero", async () => {
    const client = makeClient();
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(result.total_usd).toBe(0);
    expect(result.notes.some((n) => n.toLowerCase().includes("no spend"))).toBe(
      true,
    );
  });

  it("flags storage-dominant spend when network volume cost exceeds pods+endpoints", async () => {
    const client = makeClient({
      getBillingPods: vi.fn().mockResolvedValue({
        records: [{ amount: 5, podId: "p1" }],
      }),
      getBillingEndpoints: vi.fn().mockResolvedValue({
        records: [{ amount: 2, endpointId: "ep1" }],
      }),
      getBillingNetworkVolumes: vi.fn().mockResolvedValue({
        records: [{ amount: 100 }],
      }),
    });
    const result = await costAudit.handler(
      costAudit.inputSchema.parse({ days: 7 }),
      { client: client as unknown as never },
    );
    expect(
      result.notes.some((n) => n.toLowerCase().includes("storage")),
    ).toBe(true);
  });
});
