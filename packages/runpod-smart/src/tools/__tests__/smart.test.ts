import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import { spinTrainingPod, TRAINING_IMAGES } from "../smart.js";

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
