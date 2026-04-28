import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import { spinTrainingPod, TRAINING_IMAGES, killIdlePods } from "../smart.js";

type FakeLaunchClient = {
  createPod: ReturnType<typeof vi.fn>;
  defaultGpu?: string;
};

function makeLaunchClient(
  overrides: Partial<FakeLaunchClient> = {},
): FakeLaunchClient {
  const created = {
    id: "pod_train",
    name: "trainer",
    image: TRAINING_IMAGES.pytorch["12.1"],
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

describe("spinTrainingPod — metadata", () => {
  it("has correct name and description", () => {
    expect(spinTrainingPod.name).toBe("spin_training_pod");
    expect(spinTrainingPod.description).toBe(
      "Launch a pre-configured GPU pod for ML training.",
    );
    expect(spinTrainingPod.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("spinTrainingPod — schema", () => {
  it("applies defaults: framework=pytorch, cuda=12.1, gpu_count=1, volume_gb=100, confirm=false", () => {
    const parsed = spinTrainingPod.inputSchema.parse({ name: "trainer" }) as {
      framework: string;
      cuda: string;
      gpu_count: number;
      volume_gb: number;
      confirm: boolean;
    };
    expect(parsed.framework).toBe("pytorch");
    expect(parsed.cuda).toBe("12.1");
    expect(parsed.gpu_count).toBe(1);
    expect(parsed.volume_gb).toBe(100);
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty name", () => {
    expect(() => spinTrainingPod.inputSchema.parse({ name: "" })).toThrow();
  });

  it("rejects invalid framework", () => {
    expect(() =>
      spinTrainingPod.inputSchema.parse({ name: "x", framework: "mxnet" }),
    ).toThrow();
  });

  it("rejects invalid cuda version", () => {
    expect(() =>
      spinTrainingPod.inputSchema.parse({ name: "x", cuda: "10.2" }),
    ).toThrow();
  });

  it("rejects gpu_count: 0 (min 1)", () => {
    expect(() =>
      spinTrainingPod.inputSchema.parse({ name: "x", gpu_count: 0 }),
    ).toThrow();
  });

  it("rejects gpu_count: 9 (max 8)", () => {
    expect(() =>
      spinTrainingPod.inputSchema.parse({ name: "x", gpu_count: 9 }),
    ).toThrow();
  });

  it("rejects volume_gb above 2000", () => {
    expect(() =>
      spinTrainingPod.inputSchema.parse({ name: "x", volume_gb: 2001 }),
    ).toThrow();
  });
});

describe("spinTrainingPod — image lookup table", () => {
  it("covers all 9 framework+cuda combinations", () => {
    expect(Object.keys(TRAINING_IMAGES).sort()).toEqual([
      "jax",
      "pytorch",
      "tensorflow",
    ]);
    for (const fw of ["pytorch", "tensorflow", "jax"] as const) {
      expect(Object.keys(TRAINING_IMAGES[fw]).sort()).toEqual([
        "11.8",
        "12.1",
        "12.4",
      ]);
      for (const cuda of ["11.8", "12.1", "12.4"] as const) {
        expect(TRAINING_IMAGES[fw][cuda]).toMatch(/^runpod\//);
      }
    }
  });

  it("pytorch + cuda 12.1 resolves to a pytorch image with cuda12.1", async () => {
    const client = makeLaunchClient();
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        framework: "pytorch",
        cuda: "12.1",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.imageName).toBe(TRAINING_IMAGES.pytorch["12.1"]);
    expect(String(body.imageName)).toContain("pytorch");
    expect(String(body.imageName)).toContain("cuda12.1");
  });

  it("tensorflow + cuda 11.8 resolves to a tensorflow image with cuda11.8", async () => {
    const client = makeLaunchClient();
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        framework: "tensorflow",
        cuda: "11.8",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.imageName).toBe(TRAINING_IMAGES.tensorflow["11.8"]);
    expect(String(body.imageName)).toContain("tensorflow");
    expect(String(body.imageName)).toContain("cuda11.8");
  });

  it("jax + cuda 12.4 resolves to a jax image with cuda12.4", async () => {
    const client = makeLaunchClient();
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        framework: "jax",
        cuda: "12.4",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.imageName).toBe(TRAINING_IMAGES.jax["12.4"]);
    expect(String(body.imageName)).toContain("jax");
    expect(String(body.imageName)).toContain("cuda12.4");
  });
});

describe("spinTrainingPod — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeLaunchClient();
    await expect(
      spinTrainingPod.handler(
        spinTrainingPod.inputSchema.parse({ name: "trainer" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createPod).not.toHaveBeenCalled();
  });
});

describe("spinTrainingPod — past confirm gate, training defaults applied", () => {
  it("sends volumeInGb, volumeMountPath=/workspace, JUPYTER_PASSWORD env, and ports", async () => {
    const client = makeLaunchClient();
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        framework: "pytorch",
        cuda: "12.1",
        gpu: "NVIDIA H100 80GB HBM3",
        gpu_count: 2,
        volume_gb: 250,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.createPod).toHaveBeenCalledTimes(1);
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.name).toBe("trainer");
    expect(body.volumeInGb).toBe(250);
    expect(body.volumeMountPath).toBe("/workspace");
    expect(body.ports).toEqual(["8888/http", "22/tcp"]);
    const env = body.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.JUPYTER_PASSWORD).toBeDefined();
    expect(typeof env.JUPYTER_PASSWORD).toBe("string");
    expect(body.gpuTypeIds).toEqual(["NVIDIA H100 80GB HBM3"]);
    expect(body.gpuCount).toBe(2);
    expect(body.cloudType).toBe("SECURE");
    expect(body.interruptible).toBe(false);
  });

  it("uses client.defaultGpu when input.gpu is omitted", async () => {
    const client = makeLaunchClient({ defaultGpu: "NVIDIA RTX A6000" });
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.gpuTypeIds).toEqual(["NVIDIA RTX A6000"]);
  });

  it("falls back to RTX 4090 when neither input.gpu nor defaultGpu is set", async () => {
    const client = makeLaunchClient({ defaultGpu: undefined });
    await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createPod.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.gpuTypeIds).toEqual(["NVIDIA GeForce RTX 4090"]);
  });
});

describe("spinTrainingPod — output shape", () => {
  it("returns SlimPod fields plus connect_hint", async () => {
    const client = makeLaunchClient();
    const result = (await spinTrainingPod.handler(
      spinTrainingPod.inputSchema.parse({
        name: "trainer",
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
    expect(result.id).toBe("pod_train");
    expect(result.connect_hint).toContain("pod_train");
  });
});

// =============================================================================
// killIdlePods
// =============================================================================

type FakeKillClient = {
  listPods: ReturnType<typeof vi.fn>;
  stopPod: ReturnType<typeof vi.fn>;
};

function makeKillClient(overrides: Partial<FakeKillClient> = {}): FakeKillClient {
  return {
    listPods: vi.fn().mockResolvedValue({ pods: [] }),
    stopPod: vi.fn().mockResolvedValue({ id: "stopped" }),
    ...overrides,
  };
}

// Fixed reference time: 2026-04-27T12:00:00Z
const NOW_ISO = "2026-04-27T12:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);
const HOUR_MS = 3600 * 1000;

function hoursAgo(h: number): string {
  return new Date(NOW_MS - h * HOUR_MS).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("killIdlePods — metadata", () => {
  it("has correct name and description", () => {
    expect(killIdlePods.name).toBe("kill_idle_pods");
    expect(killIdlePods.description).toBe(
      "Stop pods running > N hours without recent activity.",
    );
    expect(killIdlePods.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("killIdlePods — schema", () => {
  it("applies defaults: older_than_hours=24, dry_run=true, confirm=false", () => {
    const parsed = killIdlePods.inputSchema.parse({}) as {
      older_than_hours: number;
      dry_run: boolean;
      confirm: boolean;
    };
    expect(parsed.older_than_hours).toBe(24);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.confirm).toBe(false);
  });

  it("rejects older_than_hours: 0 (min 1)", () => {
    expect(() =>
      killIdlePods.inputSchema.parse({ older_than_hours: 0 }),
    ).toThrow();
  });

  it("rejects older_than_hours: 721 (max 720)", () => {
    expect(() =>
      killIdlePods.inputSchema.parse({ older_than_hours: 721 }),
    ).toThrow();
  });

  it("rejects non-integer older_than_hours", () => {
    expect(() =>
      killIdlePods.inputSchema.parse({ older_than_hours: 1.5 }),
    ).toThrow();
  });
});

describe("killIdlePods — listPods filter", () => {
  it("calls client.listPods with desiredStatus=RUNNING", async () => {
    const client = makeKillClient();
    await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    );
    expect(client.listPods).toHaveBeenCalledTimes(1);
    expect(client.listPods).toHaveBeenCalledWith({ desiredStatus: "RUNNING" });
  });
});

describe("killIdlePods — idleness math", () => {
  it("filters by lastStartedAt < now - older_than_hours", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "fresh", name: "fresh", lastStartedAt: hoursAgo(1), costPerHr: 0.5 },
          { id: "old1", name: "old1", lastStartedAt: hoursAgo(25), costPerHr: 0.5 },
          { id: "old2", name: "old2", lastStartedAt: hoursAgo(100), costPerHr: 1.0 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({ older_than_hours: 24 }),
      { client: client as unknown as never },
    )) as { scanned: number; candidates: Array<{ id: string }> };
    expect(result.scanned).toBe(3);
    expect(result.candidates.map((c) => c.id).sort()).toEqual(["old1", "old2"]);
  });

  it("skips pods with no lastStartedAt", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "no-start", name: "no-start", costPerHr: 0.5 },
          { id: "old", name: "old", lastStartedAt: hoursAgo(50), costPerHr: 0.5 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { candidates: Array<{ id: string }> };
    expect(result.candidates.map((c) => c.id)).toEqual(["old"]);
  });

  it("skips pods with malformed lastStartedAt", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "bad", name: "bad", lastStartedAt: "not-a-date", costPerHr: 0.5 },
          { id: "old", name: "old", lastStartedAt: hoursAgo(50), costPerHr: 0.5 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { candidates: Array<{ id: string }> };
    expect(result.candidates.map((c) => c.id)).toEqual(["old"]);
  });
});

describe("killIdlePods — dry_run path", () => {
  it("default dry_run returns candidates with empty stopped[]", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "old", name: "old", lastStartedAt: hoursAgo(50), costPerHr: 0.7 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as {
      scanned: number;
      candidates: Array<{ id: string }>;
      stopped: Array<unknown>;
    };
    expect(result.candidates).toHaveLength(1);
    expect(result.stopped).toEqual([]);
    expect(client.stopPod).not.toHaveBeenCalled();
  });

  it("dry_run=true with confirm=true still does not stop", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "old", name: "old", lastStartedAt: hoursAgo(50), costPerHr: 0.7 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({ dry_run: true, confirm: true }),
      { client: client as unknown as never },
    )) as { stopped: Array<unknown> };
    expect(result.stopped).toEqual([]);
    expect(client.stopPod).not.toHaveBeenCalled();
  });
});

describe("killIdlePods — confirm gate", () => {
  it("dry_run=false with confirm=false throws ConfirmRequiredError with preview", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "old1", name: "old1", lastStartedAt: hoursAgo(50), costPerHr: 0.7 },
          { id: "old2", name: "old2", lastStartedAt: hoursAgo(100), costPerHr: 1.3 },
        ],
      }),
    });
    let caught: unknown;
    try {
      await killIdlePods.handler(
        killIdlePods.inputSchema.parse({ dry_run: false, confirm: false }),
        { client: client as unknown as never },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const preview = (caught as ConfirmRequiredError).preview;
    expect(preview).toContain("2");
    expect(preview).toContain("24h");
    expect(preview).toContain("2.00");
    expect(client.stopPod).not.toHaveBeenCalled();
  });
});

describe("killIdlePods — destructive path", () => {
  it("dry_run=false + confirm=true stops each candidate sequentially", async () => {
    const callOrder: string[] = [];
    const stopPod = vi.fn(async (id: string) => {
      callOrder.push(id);
      return { id };
    });
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "a", name: "a", lastStartedAt: hoursAgo(50), costPerHr: 0.5 },
          { id: "b", name: "b", lastStartedAt: hoursAgo(60), costPerHr: 0.7 },
          { id: "c", name: "c", lastStartedAt: hoursAgo(70), costPerHr: 1.0 },
        ],
      }),
      stopPod,
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({ dry_run: false, confirm: true }),
      { client: client as unknown as never },
    )) as { stopped: Array<{ id: string; ok: boolean }> };
    expect(callOrder).toEqual(["a", "b", "c"]);
    expect(result.stopped).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: true },
      { id: "c", ok: true },
    ]);
  });

  it("partial failure: continues after error and reports per-pod ok flag", async () => {
    const stopPod = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("pod busy");
      return { id };
    });
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "a", name: "a", lastStartedAt: hoursAgo(50), costPerHr: 0.5 },
          { id: "b", name: "b", lastStartedAt: hoursAgo(60), costPerHr: 0.7 },
          { id: "c", name: "c", lastStartedAt: hoursAgo(70), costPerHr: 1.0 },
        ],
      }),
      stopPod,
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({ dry_run: false, confirm: true }),
      { client: client as unknown as never },
    )) as { stopped: Array<{ id: string; ok: boolean; error?: string }> };
    expect(result.stopped).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "pod busy" },
      { id: "c", ok: true },
    ]);
    expect(stopPod).toHaveBeenCalledTimes(3);
  });

  it("empty candidates: returns empty stopped without throwing", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "fresh", name: "fresh", lastStartedAt: hoursAgo(1), costPerHr: 0.5 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({ dry_run: false, confirm: false }),
      { client: client as unknown as never },
    )) as {
      scanned: number;
      candidates: Array<unknown>;
      stopped: Array<unknown>;
      total_savings_estimate_per_hr: number;
    };
    expect(result.scanned).toBe(1);
    expect(result.candidates).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.total_savings_estimate_per_hr).toBe(0);
    expect(client.stopPod).not.toHaveBeenCalled();
  });
});

describe("killIdlePods — output detail", () => {
  it("total_savings_estimate_per_hr sums candidate costPerHr", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          { id: "a", name: "a", lastStartedAt: hoursAgo(50), costPerHr: 0.5 },
          { id: "b", name: "b", lastStartedAt: hoursAgo(60), costPerHr: 1.25 },
          { id: "fresh", name: "fresh", lastStartedAt: hoursAgo(1), costPerHr: 99 },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { total_savings_estimate_per_hr: number };
    expect(result.total_savings_estimate_per_hr).toBeCloseTo(1.75, 5);
  });

  it("hours_running rounds to 1 decimal place", async () => {
    const client = makeKillClient({
      listPods: vi.fn().mockResolvedValue({
        pods: [
          {
            id: "p",
            name: "p",
            // 25.36 hours ago -> rounds to 25.4
            lastStartedAt: new Date(NOW_MS - 25.36 * HOUR_MS).toISOString(),
            costPerHr: 0.5,
          },
        ],
      }),
    });
    const result = (await killIdlePods.handler(
      killIdlePods.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { candidates: Array<{ hours_running: number }> };
    expect(result.candidates[0]?.hours_running).toBe(25.4);
  });
});
