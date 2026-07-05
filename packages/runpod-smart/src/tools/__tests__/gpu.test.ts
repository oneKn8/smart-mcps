import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  listGpuTypes,
  cheapestGpu,
  estimateCost,
  mapGpuType,
  priceFor,
  availableIn,
  type SlimGpuType,
} from "../gpu.js";

// ---------------------------------------------------------------------------
// Fixture: four GPU types with deliberately mixed pricing + availability.
//   4090  : both clouds, secure 0.69 / community 0.44        -> ANY min 0.44
//   H100  : secure only, secure 2.99 (community price null)  -> ANY min 2.99
//   A40   : community only, community 0.39 (secure null)     -> ANY min 0.39
//   A4000 : both clouds, NO price anywhere (lowestPrice null) -> price null
// ---------------------------------------------------------------------------
const gpu4090 = {
  id: "NVIDIA GeForce RTX 4090",
  displayName: "RTX 4090",
  memoryInGb: 24,
  secureCloud: true,
  communityCloud: true,
  securePrice: 0.69,
  communityPrice: 0.44,
  lowestPrice: { minimumBidPrice: 0.35, uninterruptablePrice: 0.44 },
};

const gpuH100 = {
  id: "NVIDIA H100 80GB HBM3",
  displayName: "H100 80GB HBM3",
  memoryInGb: 80,
  secureCloud: true,
  communityCloud: false,
  securePrice: 2.99,
  communityPrice: null,
  lowestPrice: { minimumBidPrice: 2.5, uninterruptablePrice: 2.99 },
};

const gpuA40 = {
  id: "NVIDIA A40",
  displayName: "A40",
  memoryInGb: 48,
  secureCloud: false,
  communityCloud: true,
  securePrice: null,
  communityPrice: 0.39,
  lowestPrice: { minimumBidPrice: 0.3, uninterruptablePrice: 0.39 },
};

const gpuA4000 = {
  id: "NVIDIA RTX A4000",
  displayName: "RTX A4000",
  memoryInGb: 16,
  secureCloud: true,
  communityCloud: true,
  securePrice: null,
  communityPrice: null,
  lowestPrice: null,
  // Upstream-only field the slim mapper must strip:
  manufacturer: "Nvidia",
};

const ALL_GPUS = [gpu4090, gpuH100, gpuA40, gpuA4000];

type FakeClient = {
  listGpuTypes: ReturnType<typeof vi.fn>;
  defaultGpu?: string;
};

function makeClient(
  gpuTypes: Array<Record<string, unknown>>,
  defaultGpu?: string,
): FakeClient {
  return {
    listGpuTypes: vi.fn().mockResolvedValue({ gpuTypes }),
    defaultGpu,
  };
}

const SLIM_KEYS = [
  "id",
  "displayName",
  "memoryInGb",
  "secureCloud",
  "communityCloud",
  "securePrice",
  "communityPrice",
  "pricePerHr",
].sort();

// ===========================================================================
// helpers: priceFor / availableIn
// ===========================================================================

describe("priceFor", () => {
  it("SECURE uses securePrice when present", () => {
    expect(priceFor(gpu4090, "SECURE")).toBe(0.69);
  });

  it("COMMUNITY uses communityPrice when present", () => {
    expect(priceFor(gpu4090, "COMMUNITY")).toBe(0.44);
  });

  it("ANY returns the cheaper of secure/community", () => {
    expect(priceFor(gpu4090, "ANY")).toBe(0.44);
  });

  it("SECURE falls back to lowestPrice.uninterruptablePrice when securePrice is null", () => {
    expect(priceFor(gpuA40, "SECURE")).toBe(0.39);
  });

  it("COMMUNITY falls back to lowestPrice.uninterruptablePrice when communityPrice is null", () => {
    expect(priceFor(gpuH100, "COMMUNITY")).toBe(2.99);
  });

  it("returns null when no price data exists in any form", () => {
    expect(priceFor(gpuA4000, "SECURE")).toBeNull();
    expect(priceFor(gpuA4000, "COMMUNITY")).toBeNull();
    expect(priceFor(gpuA4000, "ANY")).toBeNull();
  });

  it("null-safe when lowestPrice is missing entirely", () => {
    expect(priceFor({ id: "x" }, "ANY")).toBeNull();
  });
});

describe("availableIn", () => {
  it("SECURE reflects secureCloud flag", () => {
    expect(availableIn(gpu4090, "SECURE")).toBe(true);
    expect(availableIn(gpuA40, "SECURE")).toBe(false);
  });

  it("COMMUNITY reflects communityCloud flag", () => {
    expect(availableIn(gpuH100, "COMMUNITY")).toBe(false);
    expect(availableIn(gpuA40, "COMMUNITY")).toBe(true);
  });

  it("ANY is true when either pool is available", () => {
    expect(availableIn(gpuA40, "ANY")).toBe(true);
    expect(availableIn(gpuH100, "ANY")).toBe(true);
  });

  it("treats a missing availability flag as not-available", () => {
    expect(availableIn({ id: "x" }, "SECURE")).toBe(false);
    expect(availableIn({ id: "x" }, "ANY")).toBe(false);
  });
});

// ===========================================================================
// mapGpuType
// ===========================================================================

describe("mapGpuType", () => {
  it("produces the slim shape and strips upstream extras", () => {
    const slim = mapGpuType(gpuA4000, "ANY");
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).not.toHaveProperty("manufacturer");
    expect(slim).not.toHaveProperty("lowestPrice");
  });

  it("resolves pricePerHr for the requested cloud", () => {
    expect(mapGpuType(gpu4090, "SECURE").pricePerHr).toBe(0.69);
    expect(mapGpuType(gpu4090, "COMMUNITY").pricePerHr).toBe(0.44);
    expect(mapGpuType(gpu4090, "ANY").pricePerHr).toBe(0.44);
  });

  it("keeps the raw securePrice/communityPrice fields untouched", () => {
    const slim = mapGpuType(gpuH100, "ANY");
    expect(slim.securePrice).toBe(2.99);
    expect(slim.communityPrice).toBeNull();
  });

  it("null-safes every optional field when upstream omits them", () => {
    const slim = mapGpuType({ id: "bare" }, "ANY");
    expect(slim.id).toBe("bare");
    expect(slim.displayName).toBeNull();
    expect(slim.memoryInGb).toBeNull();
    expect(slim.secureCloud).toBeNull();
    expect(slim.communityCloud).toBeNull();
    expect(slim.securePrice).toBeNull();
    expect(slim.communityPrice).toBeNull();
    expect(slim.pricePerHr).toBeNull();
  });
});

// ===========================================================================
// list_gpu_types
// ===========================================================================

describe("listGpuTypes — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listGpuTypes.name).toBe("list_gpu_types");
    expect(listGpuTypes.description).toBe(
      "List GPU types with availability and pricing.",
    );
    expect(listGpuTypes.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults cloud to ANY when omitted", () => {
    const parsed = listGpuTypes.inputSchema.parse({}) as { cloud: string };
    expect(parsed.cloud).toBe("ANY");
  });

  it("rejects a cloud value outside the enum", () => {
    expect(() => listGpuTypes.inputSchema.parse({ cloud: "SPOT" })).toThrow();
  });
});

describe("listGpuTypes — handler", () => {
  async function run(input: Record<string, unknown>): Promise<{
    gpuTypes: SlimGpuType[];
    count: number;
  }> {
    const client = makeClient(ALL_GPUS);
    return (await listGpuTypes.handler(
      listGpuTypes.inputSchema.parse(input) as never,
      { client: client as unknown as never },
    )) as { gpuTypes: SlimGpuType[]; count: number };
  }

  it("cloud=ANY sorts by cheapest available price ascending, nulls last", async () => {
    const result = await run({});
    expect(result.count).toBe(4);
    expect(result.gpuTypes.map((g) => g.id)).toEqual([
      "NVIDIA A40",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA H100 80GB HBM3",
      "NVIDIA RTX A4000",
    ]);
    expect(result.gpuTypes.map((g) => g.pricePerHr)).toEqual([
      0.39,
      0.44,
      2.99,
      null,
    ]);
  });

  it("cloud=SECURE filters out community-only GPUs and prices in secure", async () => {
    const result = await run({ cloud: "SECURE" });
    expect(result.gpuTypes.map((g) => g.id)).toEqual([
      "NVIDIA GeForce RTX 4090",
      "NVIDIA H100 80GB HBM3",
      "NVIDIA RTX A4000",
    ]);
    // A40 is community-only, excluded.
    expect(result.gpuTypes.find((g) => g.id === "NVIDIA A40")).toBeUndefined();
    expect(result.gpuTypes[0]!.pricePerHr).toBe(0.69);
  });

  it("cloud=COMMUNITY filters out secure-only GPUs and prices in community", async () => {
    const result = await run({ cloud: "COMMUNITY" });
    expect(result.gpuTypes.map((g) => g.id)).toEqual([
      "NVIDIA A40",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA RTX A4000",
    ]);
    // H100 is secure-only, excluded.
    expect(
      result.gpuTypes.find((g) => g.id === "NVIDIA H100 80GB HBM3"),
    ).toBeUndefined();
    expect(result.gpuTypes[0]!.pricePerHr).toBe(0.39);
  });

  it("min_vram_gb keeps only GPUs with memoryInGb >= threshold", async () => {
    const result = await run({ min_vram_gb: 80 });
    expect(result.count).toBe(1);
    expect(result.gpuTypes[0]!.id).toBe("NVIDIA H100 80GB HBM3");
  });

  it("name_contains matches case-insensitively on id or displayName", async () => {
    const result = await run({ name_contains: "h100" });
    expect(result.count).toBe(1);
    expect(result.gpuTypes[0]!.id).toBe("NVIDIA H100 80GB HBM3");
  });

  it("name_contains matches multiple GPUs and keeps the sort", async () => {
    const result = await run({ name_contains: "rtx" });
    expect(result.gpuTypes.map((g) => g.id)).toEqual([
      "NVIDIA GeForce RTX 4090",
      "NVIDIA RTX A4000",
    ]);
  });

  it("returns an empty list with count 0 when nothing matches", async () => {
    const result = await run({ name_contains: "does-not-exist" });
    expect(result.gpuTypes).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("emits only slim keys per GPU", async () => {
    const result = await run({});
    for (const g of result.gpuTypes) {
      expect(Object.keys(g).sort()).toEqual(SLIM_KEYS);
    }
  });
});

// ===========================================================================
// cheapest_gpu
// ===========================================================================

describe("cheapestGpu — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(cheapestGpu.name).toBe("cheapest_gpu");
    expect(cheapestGpu.description).toBe(
      "Find the cheapest GPU matching VRAM and cloud filters.",
    );
    expect(cheapestGpu.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults cloud to ANY and gpu_count to 1", () => {
    const parsed = cheapestGpu.inputSchema.parse({}) as {
      cloud: string;
      gpu_count: number;
    };
    expect(parsed.cloud).toBe("ANY");
    expect(parsed.gpu_count).toBe(1);
  });

  it("rejects gpu_count below 1", () => {
    expect(() => cheapestGpu.inputSchema.parse({ gpu_count: 0 })).toThrow();
  });
});

describe("cheapestGpu — handler", () => {
  async function run(input: Record<string, unknown>, gpus = ALL_GPUS) {
    const client = makeClient(gpus);
    return (await cheapestGpu.handler(
      cheapestGpu.inputSchema.parse(input) as never,
      { client: client as unknown as never },
    )) as {
      id: string | null;
      displayName: string | null;
      price_per_hr: number | null;
      cloud: string;
      memoryInGb: number | null;
      gpu_count: number;
      estimated_per_hr_total: number | null;
      alternatives: SlimGpuType[];
      note: string;
    };
  }

  it("returns the single cheapest priced match with alternatives", async () => {
    const result = await run({});
    expect(result.id).toBe("NVIDIA A40");
    expect(result.price_per_hr).toBe(0.39);
    expect(result.cloud).toBe("ANY");
    expect(result.memoryInGb).toBe(48);
    expect(result.gpu_count).toBe(1);
    expect(result.estimated_per_hr_total).toBe(0.39);
    // next-cheapest priced GPUs (A4000 with null price is not an alternative)
    expect(result.alternatives.map((g) => g.id)).toEqual([
      "NVIDIA GeForce RTX 4090",
      "NVIDIA H100 80GB HBM3",
    ]);
  });

  it("multiplies estimated_per_hr_total by gpu_count", async () => {
    const result = await run({ gpu_count: 4 });
    expect(result.gpu_count).toBe(4);
    expect(result.estimated_per_hr_total).toBeCloseTo(1.56, 10);
  });

  it("caps alternatives at 4", async () => {
    const many = [
      { id: "g1", secureCloud: true, memoryInGb: 8, securePrice: 0.1 },
      { id: "g2", secureCloud: true, memoryInGb: 8, securePrice: 0.2 },
      { id: "g3", secureCloud: true, memoryInGb: 8, securePrice: 0.3 },
      { id: "g4", secureCloud: true, memoryInGb: 8, securePrice: 0.4 },
      { id: "g5", secureCloud: true, memoryInGb: 8, securePrice: 0.5 },
      { id: "g6", secureCloud: true, memoryInGb: 8, securePrice: 0.6 },
    ];
    const result = await run({ cloud: "SECURE" }, many);
    expect(result.id).toBe("g1");
    expect(result.alternatives.map((g) => g.id)).toEqual([
      "g2",
      "g3",
      "g4",
      "g5",
    ]);
  });

  it("honors min_vram_gb (subsumes cheapest_h100 via 80GB filter)", async () => {
    const result = await run({ min_vram_gb: 80 });
    expect(result.id).toBe("NVIDIA H100 80GB HBM3");
    expect(result.price_per_hr).toBe(2.99);
    expect(result.alternatives).toEqual([]);
  });

  it("honors name_contains (subsumes cheapest_h100 via name filter)", async () => {
    const result = await run({ name_contains: "H100" });
    expect(result.id).toBe("NVIDIA H100 80GB HBM3");
  });

  it("returns id null with honest note when no GPU matches the filters", async () => {
    const result = await run({ name_contains: "nonexistent" });
    expect(result.id).toBeNull();
    expect(result.price_per_hr).toBeNull();
    expect(result.estimated_per_hr_total).toBeNull();
    expect(result.alternatives).toEqual([]);
    expect(result.note).toMatch(/no gpu types match/i);
  });

  it("returns id null with honest note when matches exist but none are priced", async () => {
    const result = await run({ name_contains: "a4000" });
    expect(result.id).toBeNull();
    expect(result.price_per_hr).toBeNull();
    expect(result.note).toMatch(/none have a known/i);
  });
});

// ===========================================================================
// estimate_cost
// ===========================================================================

describe("estimateCost — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(estimateCost.name).toBe("estimate_cost");
    expect(estimateCost.description).toBe("Estimate pod cost before launching.");
    expect(estimateCost.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults gpu_count to 1, hours to 1, cloud to ANY", () => {
    const parsed = estimateCost.inputSchema.parse({}) as {
      gpu_count: number;
      hours: number;
      cloud: string;
    };
    expect(parsed.gpu_count).toBe(1);
    expect(parsed.hours).toBe(1);
    expect(parsed.cloud).toBe("ANY");
  });
});

describe("estimateCost — handler", () => {
  async function run(
    input: Record<string, unknown>,
    defaultGpu?: string,
    gpus = ALL_GPUS,
  ) {
    const client = makeClient(gpus, defaultGpu);
    return (await estimateCost.handler(
      estimateCost.inputSchema.parse(input) as never,
      { client: client as unknown as never },
    )) as {
      gpu: string;
      gpu_count: number;
      price_per_hr: number | null;
      hours: number;
      estimated_total_usd: number | null;
      cloud: string;
      note: string;
    };
  }

  it("prices an explicit GPU in the requested cloud", async () => {
    const result = await run({
      gpu: "NVIDIA GeForce RTX 4090",
      cloud: "SECURE",
    });
    expect(result.gpu).toBe("NVIDIA GeForce RTX 4090");
    expect(result.price_per_hr).toBe(0.69);
    expect(result.estimated_total_usd).toBe(0.69);
    expect(result.cloud).toBe("SECURE");
  });

  it("multiplies price by gpu_count and hours", async () => {
    const result = await run({
      gpu: "NVIDIA GeForce RTX 4090",
      cloud: "ANY",
      gpu_count: 2,
      hours: 3,
    });
    expect(result.price_per_hr).toBe(0.44);
    expect(result.estimated_total_usd).toBeCloseTo(2.64, 10);
  });

  it("returns null price + honest note when the GPU id is not in the pricing table", async () => {
    const result = await run({ gpu: "NVIDIA Made Up 9000" });
    expect(result.gpu).toBe("NVIDIA Made Up 9000");
    expect(result.price_per_hr).toBeNull();
    expect(result.estimated_total_usd).toBeNull();
    expect(result.note).toMatch(/not found/i);
  });

  it("returns null price + honest note when the GPU has no price for that cloud", async () => {
    const result = await run({ gpu: "NVIDIA RTX A4000", cloud: "SECURE" });
    expect(result.price_per_hr).toBeNull();
    expect(result.estimated_total_usd).toBeNull();
    expect(result.note).toMatch(/no secure price/i);
  });

  it("resolves the GPU from client.defaultGpu when input.gpu is omitted", async () => {
    const result = await run({ cloud: "SECURE" }, "NVIDIA H100 80GB HBM3");
    expect(result.gpu).toBe("NVIDIA H100 80GB HBM3");
    expect(result.price_per_hr).toBe(2.99);
  });

  it("falls back to the hardcoded RTX 4090 when neither input.gpu nor defaultGpu is set", async () => {
    const result = await run({});
    expect(result.gpu).toBe("NVIDIA GeForce RTX 4090");
    expect(result.price_per_hr).toBe(0.44);
  });

  it("emits exactly the documented output keys", async () => {
    const result = await run({ gpu: "NVIDIA A40", cloud: "COMMUNITY" });
    expect(Object.keys(result).sort()).toEqual(
      [
        "gpu",
        "gpu_count",
        "price_per_hr",
        "hours",
        "estimated_total_usd",
        "cloud",
        "note",
      ].sort(),
    );
  });
});
