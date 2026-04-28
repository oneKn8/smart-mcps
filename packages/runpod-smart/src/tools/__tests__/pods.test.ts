import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listPods } from "../pods.js";

type FakeClient = {
  listPods: ReturnType<typeof vi.fn>;
};

function makeClient(pods: Array<Record<string, unknown>>): FakeClient {
  return {
    listPods: vi.fn().mockResolvedValue({ pods }),
  };
}

describe("listPods — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listPods.name).toBe("list_pods");
    expect(listPods.description).toBe("List all Runpod pods.");
    const parsed = listPods.inputSchema.parse({}) as { status: string };
    expect(parsed.status).toBe("ALL");
    expect(listPods.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects status values outside the enum", () => {
    expect(() => listPods.inputSchema.parse({ status: "PAUSED" })).toThrow();
  });
});

describe("listPods — status filter mapping", () => {
  it("status=ALL (default) calls client.listPods() with no opts", async () => {
    const client = makeClient([]);
    await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledTimes(1);
    expect(client.listPods).toHaveBeenCalledWith();
  });

  it("status=ALL explicit also calls client.listPods() with no opts", async () => {
    const client = makeClient([]);
    await listPods.handler(
      listPods.inputSchema.parse({ status: "ALL" }) as {
        status: "ALL" | "RUNNING" | "STOPPED";
      },
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledWith();
  });

  it("status=RUNNING maps to { desiredStatus: 'RUNNING' }", async () => {
    const client = makeClient([]);
    await listPods.handler(
      listPods.inputSchema.parse({ status: "RUNNING" }) as {
        status: "ALL" | "RUNNING" | "STOPPED";
      },
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledWith({ desiredStatus: "RUNNING" });
  });

  it("status=STOPPED maps to { desiredStatus: 'STOPPED' }", async () => {
    const client = makeClient([]);
    await listPods.handler(
      listPods.inputSchema.parse({ status: "STOPPED" }) as {
        status: "ALL" | "RUNNING" | "STOPPED";
      },
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledWith({ desiredStatus: "STOPPED" });
  });
});

describe("listPods — output mapping", () => {
  it("maps pod fields to slim shape with all 9 fields populated", async () => {
    const client = makeClient([
      {
        id: "pod_abc",
        name: "training-rig",
        image: "runpod/pytorch:2.1.0",
        desiredStatus: "RUNNING",
        costPerHr: 0.74,
        adjustedCostPerHr: 0.69,
        gpu: { displayName: "RTX 4090" },
        gpuCount: 2,
        lastStartedAt: "2026-04-26T18:00:00.000Z",
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as {
      pods: Array<{
        id: string;
        name: string | null;
        status: string;
        image: string | null;
        gpu: { displayName: string; count: number };
        costPerHr: number;
        adjustedCostPerHr: number;
        lastStartedAt: string | null;
      }>;
      count: number;
    };

    expect(result.pods[0]).toEqual({
      id: "pod_abc",
      name: "training-rig",
      status: "RUNNING",
      image: "runpod/pytorch:2.1.0",
      gpu: { displayName: "RTX 4090", count: 2 },
      costPerHr: 0.74,
      adjustedCostPerHr: 0.69,
      lastStartedAt: "2026-04-26T18:00:00.000Z",
    });
  });

  it("strips upstream extra fields (only listed keys are present)", async () => {
    const client = makeClient([
      {
        id: "pod_abc",
        name: "training-rig",
        image: "runpod/pytorch:2.1.0",
        desiredStatus: "RUNNING",
        costPerHr: 0.74,
        adjustedCostPerHr: 0.69,
        gpu: { displayName: "RTX 4090" },
        gpuCount: 1,
        lastStartedAt: "2026-04-26T18:00:00.000Z",
        // Extra Runpod fields that should NOT pass through:
        internalRouteId: "route_should_be_stripped",
        containerRegistryAuthId: "auth_should_be_stripped",
        machineId: "m_xyz",
        env: [{ key: "FOO", value: "bar" }],
        ports: ["8888/http"],
        volumeInGb: 50,
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<Record<string, unknown>> };

    const pod = result.pods[0]!;
    const keys = Object.keys(pod).sort();
    expect(keys).toEqual(
      [
        "id",
        "name",
        "status",
        "image",
        "gpu",
        "costPerHr",
        "adjustedCostPerHr",
        "lastStartedAt",
      ].sort(),
    );
    expect(pod).not.toHaveProperty("internalRouteId");
    expect(pod).not.toHaveProperty("containerRegistryAuthId");
    expect(pod).not.toHaveProperty("machineId");
    expect(pod).not.toHaveProperty("env");
    expect(pod).not.toHaveProperty("ports");
    expect(pod).not.toHaveProperty("volumeInGb");
    expect(pod).not.toHaveProperty("desiredStatus");
    expect(pod).not.toHaveProperty("gpuCount");
  });

  it("null-safe lastStartedAt: explicit null passes through", async () => {
    const client = makeClient([
      {
        id: "pod_x",
        name: "n",
        image: "i",
        desiredStatus: "EXITED",
        costPerHr: 0.1,
        adjustedCostPerHr: 0.1,
        gpu: { displayName: "RTX 3060" },
        gpuCount: 1,
        lastStartedAt: null,
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<{ lastStartedAt: string | null }> };
    expect(result.pods[0]?.lastStartedAt).toBeNull();
  });

  it("null-safe lastStartedAt: missing field becomes null", async () => {
    const client = makeClient([
      {
        id: "pod_x",
        name: "n",
        image: "i",
        desiredStatus: "EXITED",
        costPerHr: 0.1,
        adjustedCostPerHr: 0.1,
        gpu: { displayName: "RTX 3060" },
        gpuCount: 1,
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<{ lastStartedAt: string | null }> };
    expect(result.pods[0]?.lastStartedAt).toBeNull();
  });

  it("null-safe gpu: missing gpu object yields default {displayName:'', count:0}", async () => {
    const client = makeClient([
      {
        id: "pod_no_gpu",
        name: "cpu-only",
        image: "alpine",
        desiredStatus: "RUNNING",
        costPerHr: 0.05,
        adjustedCostPerHr: 0.05,
        // gpu intentionally omitted
        // gpuCount intentionally omitted
        lastStartedAt: "2026-04-26T00:00:00.000Z",
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<{ gpu: { displayName: string; count: number } }> };
    expect(result.pods[0]?.gpu).toEqual({ displayName: "", count: 0 });
  });

  it("null-safe image: missing image becomes null", async () => {
    const client = makeClient([
      {
        id: "pod_x",
        name: "n",
        // image intentionally omitted
        desiredStatus: "RUNNING",
        costPerHr: 0.1,
        adjustedCostPerHr: 0.1,
        gpu: { displayName: "RTX 3060" },
        gpuCount: 1,
        lastStartedAt: "2026-04-26T00:00:00.000Z",
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<{ image: string | null }> };
    expect(result.pods[0]?.image).toBeNull();
  });

  it("null-safe name: missing name becomes null", async () => {
    const client = makeClient([
      {
        id: "pod_x",
        // name intentionally omitted
        image: "alpine",
        desiredStatus: "RUNNING",
        costPerHr: 0.1,
        adjustedCostPerHr: 0.1,
        gpu: { displayName: "RTX 3060" },
        gpuCount: 1,
        lastStartedAt: "2026-04-26T00:00:00.000Z",
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { pods: Array<{ name: string | null }> };
    expect(result.pods[0]?.name).toBeNull();
  });

  it("count matches pods.length", async () => {
    const client = makeClient([
      { id: "a", desiredStatus: "RUNNING", costPerHr: 1, adjustedCostPerHr: 1 },
      { id: "b", desiredStatus: "RUNNING", costPerHr: 1, adjustedCostPerHr: 1 },
      { id: "c", desiredStatus: "EXITED", costPerHr: 1, adjustedCostPerHr: 1 },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as { count: number; pods: unknown[] };
    expect(result.count).toBe(3);
    expect(result.pods).toHaveLength(3);
  });

  it("preserves numeric cost values unchanged", async () => {
    const client = makeClient([
      {
        id: "pod_cost",
        name: "n",
        image: "i",
        desiredStatus: "RUNNING",
        costPerHr: 0.34,
        adjustedCostPerHr: 0.29,
        gpu: { displayName: "RTX 3090" },
        gpuCount: 1,
        lastStartedAt: "2026-04-26T00:00:00.000Z",
      },
    ]);
    const result = (await listPods.handler(
      listPods.inputSchema.parse({}) as { status: "ALL" | "RUNNING" | "STOPPED" },
      { client: client as unknown as never },
    )) as {
      pods: Array<{ costPerHr: number; adjustedCostPerHr: number }>;
    };
    expect(result.pods[0]?.costPerHr).toBe(0.34);
    expect(result.pods[0]?.adjustedCostPerHr).toBe(0.29);
  });
});
