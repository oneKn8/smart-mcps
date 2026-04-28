import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listPods,
  getPod,
  startPod,
  stopPod,
  terminatePod,
  launchPod,
} from "../pods.js";

type FakeClient = {
  listPods: ReturnType<typeof vi.fn>;
};

function makeClient(pods: Array<Record<string, unknown>>): FakeClient {
  return {
    listPods: vi.fn().mockResolvedValue({ pods }),
  };
}

type FakePodOpsClient = {
  getPod: ReturnType<typeof vi.fn>;
  startPod: ReturnType<typeof vi.fn>;
  stopPod: ReturnType<typeof vi.fn>;
  terminatePod: ReturnType<typeof vi.fn>;
};

function makePodOpsClient(overrides: Partial<FakePodOpsClient> = {}): FakePodOpsClient {
  const samplePod = {
    id: "pod_abc",
    name: "training-rig",
    image: "runpod/pytorch:2.1.0",
    desiredStatus: "RUNNING",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.69,
    gpu: { displayName: "RTX 4090" },
    gpuCount: 1,
    lastStartedAt: "2026-04-26T18:00:00.000Z",
  };
  return {
    getPod: vi.fn().mockResolvedValue(samplePod),
    startPod: vi.fn().mockResolvedValue({ ...samplePod, desiredStatus: "RUNNING" }),
    stopPod: vi.fn().mockResolvedValue({ ...samplePod, desiredStatus: "STOPPED" }),
    terminatePod: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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

// =============================================================================
// get_pod
// =============================================================================

describe("getPod — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getPod.name).toBe("get_pod");
    expect(getPod.description).toBe("Get a single Runpod pod by ID.");
    expect(getPod.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty pod_id", () => {
    expect(() => getPod.inputSchema.parse({ pod_id: "" })).toThrow();
  });
});

describe("getPod — handler", () => {
  it("calls client.getPod with the input id", async () => {
    const client = makePodOpsClient();
    await getPod.handler(
      getPod.inputSchema.parse({ pod_id: "pod_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getPod).toHaveBeenCalledTimes(1);
    expect(client.getPod).toHaveBeenCalledWith("pod_abc");
  });

  it("returns slim shape via mapPod (only listed keys)", async () => {
    const client = makePodOpsClient();
    const result = (await getPod.handler(
      getPod.inputSchema.parse({ pod_id: "pod_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    const keys = Object.keys(result).sort();
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
    expect(result).not.toHaveProperty("desiredStatus");
    expect(result).not.toHaveProperty("gpuCount");
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makePodOpsClient({
      getPod: vi.fn().mockRejectedValue(
        new NotFoundError("Pod not found: pod_x"),
      ),
    });
    await expect(
      getPod.handler(
        getPod.inputSchema.parse({ pod_id: "pod_x" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// start_pod
// =============================================================================

describe("startPod — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(startPod.name).toBe("start_pod");
    expect(startPod.description).toBe("Start a stopped Runpod pod.");
    expect(startPod.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty pod_id", () => {
    expect(() =>
      startPod.inputSchema.parse({ pod_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = startPod.inputSchema.parse({ pod_id: "pod_abc" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });
});

describe("startPod — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makePodOpsClient();
    await expect(
      startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    // startPod must NOT be called when confirm gate fails
    expect(client.startPod).not.toHaveBeenCalled();
  });

  it("preview text contains pod_id and cost-per-hr", async () => {
    const client = makePodOpsClient();
    try {
      await startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc", confirm: false }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("pod_abc");
      expect(preview).toMatch(/0\.74/);
      expect(preview).toMatch(/start/i);
    }
  });

  it("calls getPod first to build the preview", async () => {
    const client = makePodOpsClient();
    try {
      await startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
    } catch {
      // expected: confirm gate throws
    }
    expect(client.getPod).toHaveBeenCalledWith("pod_abc");
    expect(client.startPod).not.toHaveBeenCalled();
  });

  it("renders ~$?/hr when costPerHr is missing", async () => {
    const client = makePodOpsClient({
      getPod: vi.fn().mockResolvedValue({
        id: "pod_abc",
        desiredStatus: "EXITED",
        // costPerHr intentionally absent
      }),
    });
    try {
      await startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toContain("~$?/hr");
    }
  });
});

describe("startPod — past confirm gate", () => {
  it("with confirm: true calls client.startPod and returns slim shape", async () => {
    const client = makePodOpsClient();
    const result = (await startPod.handler(
      startPod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(client.startPod).toHaveBeenCalledWith("pod_abc");
    const keys = Object.keys(result).sort();
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
  });

  it("propagates NotFoundError from getPod", async () => {
    const client = makePodOpsClient({
      getPod: vi.fn().mockRejectedValue(
        new NotFoundError("Pod not found: gone"),
      ),
    });
    await expect(
      startPod.handler(
        startPod.inputSchema.parse({ pod_id: "gone", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("propagates NotFoundError from startPod", async () => {
    const client = makePodOpsClient({
      startPod: vi.fn().mockRejectedValue(
        new NotFoundError("Pod not found: pod_abc"),
      ),
    });
    await expect(
      startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      startPod.handler(
        startPod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toThrow(/Pod not found/);
  });
});

// =============================================================================
// stop_pod
// =============================================================================

describe("stopPod — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(stopPod.name).toBe("stop_pod");
    expect(stopPod.description).toBe("Stop a running Runpod pod.");
  });

  it("rejects empty pod_id", () => {
    expect(() =>
      stopPod.inputSchema.parse({ pod_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = stopPod.inputSchema.parse({ pod_id: "pod_abc" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });
});

describe("stopPod — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makePodOpsClient();
    await expect(
      stopPod.handler(
        stopPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.stopPod).not.toHaveBeenCalled();
  });

  it("preview text contains pod_id, 'stop', and cost-per-hr", async () => {
    const client = makePodOpsClient();
    try {
      await stopPod.handler(
        stopPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("pod_abc");
      expect(preview).toMatch(/stop/i);
      expect(preview).toMatch(/0\.74/);
    }
  });

  it("calls getPod first to build the preview", async () => {
    const client = makePodOpsClient();
    try {
      await stopPod.handler(
        stopPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
    } catch {
      // expected
    }
    expect(client.getPod).toHaveBeenCalledWith("pod_abc");
    expect(client.stopPod).not.toHaveBeenCalled();
  });

  it("renders ~$?/hr when costPerHr is missing", async () => {
    const client = makePodOpsClient({
      getPod: vi.fn().mockResolvedValue({
        id: "pod_abc",
        desiredStatus: "RUNNING",
      }),
    });
    try {
      await stopPod.handler(
        stopPod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("~$?/hr");
    }
  });
});

describe("stopPod — past confirm gate", () => {
  it("with confirm: true calls client.stopPod and returns slim shape", async () => {
    const client = makePodOpsClient();
    const result = (await stopPod.handler(
      stopPod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(client.stopPod).toHaveBeenCalledWith("pod_abc");
    expect(result).toHaveProperty("id", "pod_abc");
    expect(result).toHaveProperty("status", "STOPPED");
    expect(result).not.toHaveProperty("desiredStatus");
  });

  it("propagates NotFoundError from stopPod", async () => {
    const client = makePodOpsClient({
      stopPod: vi.fn().mockRejectedValue(
        new NotFoundError("Pod not found: pod_abc"),
      ),
    });
    await expect(
      stopPod.handler(
        stopPod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// terminate_pod
// =============================================================================

describe("terminatePod — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(terminatePod.name).toBe("terminate_pod");
    expect(terminatePod.description).toBe("Permanently delete a Runpod pod.");
  });

  it("rejects empty pod_id", () => {
    expect(() =>
      terminatePod.inputSchema.parse({ pod_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = terminatePod.inputSchema.parse({ pod_id: "pod_abc" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });
});

describe("terminatePod — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makePodOpsClient();
    await expect(
      terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.terminatePod).not.toHaveBeenCalled();
  });

  it("preview contains literal 'PERMANENTLY DELETE'", async () => {
    const client = makePodOpsClient();
    try {
      await terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toContain(
        "PERMANENTLY DELETE",
      );
    }
  });

  it("preview contains pod_id and cost-per-hr", async () => {
    const client = makePodOpsClient();
    try {
      await terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("pod_abc");
      expect(preview).toMatch(/0\.74/);
    }
  });

  it("calls getPod first; does not call terminatePod if confirm is false", async () => {
    const client = makePodOpsClient();
    try {
      await terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
    } catch {
      // expected
    }
    expect(client.getPod).toHaveBeenCalledWith("pod_abc");
    expect(client.terminatePod).not.toHaveBeenCalled();
  });

  it("renders ~$?/hr when costPerHr is missing", async () => {
    const client = makePodOpsClient({
      getPod: vi.fn().mockResolvedValue({
        id: "pod_abc",
        desiredStatus: "RUNNING",
      }),
    });
    try {
      await terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("~$?/hr");
    }
  });
});

describe("terminatePod — past confirm gate", () => {
  it("with confirm: true calls client.terminatePod and returns confirmation object", async () => {
    const client = makePodOpsClient();
    const result = (await terminatePod.handler(
      terminatePod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
      { client: client as unknown as never },
    )) as { pod_id: string; terminated: boolean };
    expect(client.terminatePod).toHaveBeenCalledWith("pod_abc");
    expect(result).toEqual({ pod_id: "pod_abc", terminated: true });
  });

  it("propagates NotFoundError from terminatePod", async () => {
    const client = makePodOpsClient({
      terminatePod: vi.fn().mockRejectedValue(
        new NotFoundError("Pod not found: pod_abc"),
      ),
    });
    await expect(
      terminatePod.handler(
        terminatePod.inputSchema.parse({ pod_id: "pod_abc", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// launch_pod
// =============================================================================

type FakeLaunchClient = {
  createPod: ReturnType<typeof vi.fn>;
  defaultGpu?: string;
};

function makeLaunchClient(
  overrides: Partial<FakeLaunchClient> = {},
): FakeLaunchClient {
  const created = {
    id: "pod_new",
    name: "fresh",
    image: "runpod/pytorch:2.1.0",
    desiredStatus: "CREATED",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.74,
    gpu: { displayName: "RTX 4090" },
    gpuCount: 1,
    lastStartedAt: null,
  };
  return {
    createPod: vi.fn().mockResolvedValue(created),
    defaultGpu: undefined,
    ...overrides,
  };
}

describe("launchPod — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(launchPod.name).toBe("launch_pod");
    expect(launchPod.description).toBe(
      "Launch a new GPU pod with image, GPU type, and resource config.",
    );
    expect(launchPod.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty name", () => {
    expect(() =>
      launchPod.inputSchema.parse({ name: "", image: "x" }),
    ).toThrow();
  });

  it("rejects empty image", () => {
    expect(() =>
      launchPod.inputSchema.parse({ name: "x", image: "" }),
    ).toThrow();
  });

  it("rejects gpu_count: 0 (min 1)", () => {
    expect(() =>
      launchPod.inputSchema.parse({ name: "x", image: "y", gpu_count: 0 }),
    ).toThrow();
  });

  it("rejects gpu_count: 9 (max 8)", () => {
    expect(() =>
      launchPod.inputSchema.parse({ name: "x", image: "y", gpu_count: 9 }),
    ).toThrow();
  });

  it("rejects container_disk_gb: 4 (min 5)", () => {
    expect(() =>
      launchPod.inputSchema.parse({
        name: "x",
        image: "y",
        container_disk_gb: 4,
      }),
    ).toThrow();
  });

  it("applies defaults when fields are omitted", () => {
    const parsed = launchPod.inputSchema.parse({
      name: "x",
      image: "y",
    }) as {
      gpu_count: number;
      cloud_type: string;
      container_disk_gb: number;
      volume_gb: number;
      volume_mount_path: string;
      ports: string[];
      interruptible: boolean;
      confirm: boolean;
    };
    expect(parsed.gpu_count).toBe(1);
    expect(parsed.cloud_type).toBe("SECURE");
    expect(parsed.container_disk_gb).toBe(50);
    expect(parsed.volume_gb).toBe(0);
    expect(parsed.volume_mount_path).toBe("/workspace");
    expect(parsed.ports).toEqual(["8888/http", "22/tcp"]);
    expect(parsed.interruptible).toBe(false);
    expect(parsed.confirm).toBe(false);
  });
});

describe("launchPod — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeLaunchClient();
    await expect(
      launchPod.handler(
        launchPod.inputSchema.parse({
          name: "fresh",
          image: "runpod/pytorch:2.1.0",
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createPod).not.toHaveBeenCalled();
  });

  it("preview text contains name, image, gpu, count, cloud_type, disk, and cost-deferred phrasing", async () => {
    const client = makeLaunchClient();
    try {
      await launchPod.handler(
        launchPod.inputSchema.parse({
          name: "fresh",
          image: "runpod/pytorch:2.1.0",
          gpu: "NVIDIA RTX A6000",
          gpu_count: 2,
          cloud_type: "COMMUNITY",
          container_disk_gb: 75,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("fresh");
      expect(preview).toContain("runpod/pytorch:2.1.0");
      expect(preview).toContain("NVIDIA RTX A6000");
      expect(preview).toContain("x2");
      expect(preview).toContain("COMMUNITY");
      expect(preview).toContain("75GB");
      expect(preview).toContain("cost shown after creation");
    }
  });
});

describe("launchPod — default-GPU resolution", () => {
  it("uses input.gpu when provided (overrides env and fallback)", async () => {
    const client = makeLaunchClient({
      defaultGpu: "NVIDIA RTX A6000",
    });
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        gpu: "NVIDIA H100 80GB HBM3",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.gpuTypeIds).toEqual(["NVIDIA H100 80GB HBM3"]);
  });

  it("falls back to client.defaultGpu when input.gpu is omitted", async () => {
    const client = makeLaunchClient({
      defaultGpu: "NVIDIA RTX A6000",
    });
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.gpuTypeIds).toEqual(["NVIDIA RTX A6000"]);
  });

  it("falls back to hardcoded RTX 4090 when neither input.gpu nor defaultGpu is set", async () => {
    const client = makeLaunchClient({ defaultGpu: undefined });
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.gpuTypeIds).toEqual(["NVIDIA GeForce RTX 4090"]);
  });
});

describe("launchPod — body mapping (snake → camel)", () => {
  it("maps all snake_case fields to camelCase wire shape", async () => {
    const client = makeLaunchClient();
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "runpod/pytorch:2.1.0",
        gpu: "NVIDIA GeForce RTX 4090",
        gpu_count: 2,
        cloud_type: "SECURE",
        container_disk_gb: 100,
        volume_gb: 200,
        volume_mount_path: "/data",
        ports: ["8888/http", "22/tcp"],
        env: { FOO: "bar" },
        template_id: "tmpl_xyz",
        interruptible: true,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      name: "fresh",
      imageName: "runpod/pytorch:2.1.0",
      gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
      gpuCount: 2,
      cloudType: "SECURE",
      containerDiskInGb: 100,
      volumeInGb: 200,
      volumeMountPath: "/data",
      ports: ["8888/http", "22/tcp"],
      env: { FOO: "bar" },
      templateId: "tmpl_xyz",
      interruptible: true,
    });
    // computeType is implied default — not sent
    expect(body).not.toHaveProperty("computeType");
  });

  it("omits volumeInGb and volumeMountPath when volume_gb is 0", async () => {
    const client = makeLaunchClient();
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("volumeInGb");
    expect(body).not.toHaveProperty("volumeMountPath");
  });

  it("omits env when not provided", async () => {
    const client = makeLaunchClient();
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("env");
  });

  it("omits templateId when not provided", async () => {
    const client = makeLaunchClient();
    await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("templateId");
  });
});

describe("launchPod — output shape", () => {
  it("returns SlimPod fields plus connect_hint (exact key set)", async () => {
    const client = makeLaunchClient();
    const result = (await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    const keys = Object.keys(result).sort();
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
        "connect_hint",
      ].sort(),
    );
  });

  it("connect_hint contains the pod id and runpodctl exec invocation", async () => {
    const client = makeLaunchClient();
    const result = (await launchPod.handler(
      launchPod.inputSchema.parse({
        name: "fresh",
        image: "x",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { connect_hint: string };
    expect(result.connect_hint).toContain("pod_new");
    expect(result.connect_hint).toContain("runpodctl exec --pod pod_new bash");
  });
});
