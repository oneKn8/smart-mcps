import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import {
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./null-helpers.js";

// The three GPU-pricing tools share one notion of "which cloud". SECURE and
// COMMUNITY are Runpod's two capacity pools; ANY means "cheapest of either".
type Cloud = "SECURE" | "COMMUNITY" | "ANY";

const cloudEnum = z.enum(["SECURE", "COMMUNITY", "ANY"]);

// Slim view of a GraphQL GpuType. Mirrors the camelCase convention used by
// SlimPod/SlimTemplate. The nested `lowestPrice` object is dropped after
// flattening its `uninterruptablePrice` fallback into `pricePerHr`, and the
// upstream `lowestPrice.minimumBidPrice` (spot bidding) is not surfaced here.
// `pricePerHr` is the cheapest price actually payable in the requested cloud.
export type SlimGpuType = {
  id: string;
  displayName: string | null;
  memoryInGb: number | null;
  secureCloud: boolean | null;
  communityCloud: boolean | null;
  securePrice: number | null;
  communityPrice: number | null;
  pricePerHr: number | null;
};

// Pulls `lowestPrice.uninterruptablePrice` off an upstream GpuType record.
// This is the on-demand (non-spot) price Runpod quotes when the flat
// secure/community price is absent. Returns null when the object or field
// is missing.
function uninterruptablePrice(gpu: Record<string, unknown>): number | null {
  const lp = gpu.lowestPrice;
  if (lp === null || typeof lp !== "object") return null;
  return nullableNumber((lp as Record<string, unknown>).uninterruptablePrice);
}

// The price payable for `gpu` in `cloud`, or null when no price is known:
//   SECURE    -> securePrice, else the uninterruptable fallback
//   COMMUNITY -> communityPrice, else the uninterruptable fallback
//   ANY       -> the cheaper of the two above (nulls ignored)
// Never fabricates a number; a GPU with no pricing data yields null.
export function priceFor(gpu: Record<string, unknown>, cloud: Cloud): number | null {
  const fallback = uninterruptablePrice(gpu);
  const secure = nullableNumber(gpu.securePrice) ?? fallback;
  const community = nullableNumber(gpu.communityPrice) ?? fallback;
  if (cloud === "SECURE") return secure;
  if (cloud === "COMMUNITY") return community;
  const candidates = [secure, community].filter(
    (n): n is number => n !== null,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// Whether `gpu` has capacity in `cloud`:
//   SECURE    -> secureCloud
//   COMMUNITY -> communityCloud
//   ANY       -> either pool
// A missing/non-boolean availability flag is treated as "not available".
export function availableIn(gpu: Record<string, unknown>, cloud: Cloud): boolean {
  const secure = nullableBoolean(gpu.secureCloud) === true;
  const community = nullableBoolean(gpu.communityCloud) === true;
  if (cloud === "SECURE") return secure;
  if (cloud === "COMMUNITY") return community;
  return secure || community;
}

// Maps an upstream GpuType to the slim shape. `pricePerHr` is resolved for the
// requested cloud so callers see the price they would actually pay there.
export function mapGpuType(g: Record<string, unknown>, cloud: Cloud): SlimGpuType {
  return {
    id: typeof g.id === "string" ? g.id : "",
    displayName: nullableString(g.displayName),
    memoryInGb: nullableNumber(g.memoryInGb),
    secureCloud: nullableBoolean(g.secureCloud),
    communityCloud: nullableBoolean(g.communityCloud),
    securePrice: nullableNumber(g.securePrice),
    communityPrice: nullableNumber(g.communityPrice),
    pricePerHr: priceFor(g, cloud),
  };
}

// Shared filter used by list_gpu_types and cheapest_gpu.
interface GpuFilter {
  cloud: Cloud;
  minVramGb?: number;
  nameContains?: string;
}

function matchesFilter(gpu: Record<string, unknown>, filter: GpuFilter): boolean {
  if (!availableIn(gpu, filter.cloud)) return false;
  if (filter.minVramGb !== undefined) {
    const mem = nullableNumber(gpu.memoryInGb);
    if (mem === null || mem < filter.minVramGb) return false;
  }
  if (filter.nameContains !== undefined && filter.nameContains !== "") {
    const needle = filter.nameContains.toLowerCase();
    const id = typeof gpu.id === "string" ? gpu.id.toLowerCase() : "";
    const displayName = (nullableString(gpu.displayName) ?? "").toLowerCase();
    if (!id.includes(needle) && !displayName.includes(needle)) return false;
  }
  return true;
}

// Sort slim GPUs by pricePerHr ascending, pushing unknown (null) prices last.
function byPriceAsc(a: SlimGpuType, b: SlimGpuType): number {
  if (a.pricePerHr === null && b.pricePerHr === null) return 0;
  if (a.pricePerHr === null) return 1;
  if (b.pricePerHr === null) return -1;
  return a.pricePerHr - b.pricePerHr;
}

// =============================================================================
// list_gpu_types
// =============================================================================

const listGpuTypesInputSchema = z.object({
  min_vram_gb: z.number().min(0).optional(),
  cloud: cloudEnum.optional().default("ANY"),
  name_contains: z.string().optional(),
});

type ListGpuTypesInput = z.infer<typeof listGpuTypesInputSchema>;

type ListGpuTypesOutput = {
  gpuTypes: SlimGpuType[];
  count: number;
};

export const listGpuTypes = defineTool<
  ListGpuTypesInput,
  ListGpuTypesOutput,
  RunpodContext
>({
  name: "list_gpu_types",
  description: "List GPU types with availability and pricing.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `cloud | undefined` but its output type is the resolved union.
  inputSchema: listGpuTypesInputSchema as unknown as z.ZodType<ListGpuTypesInput>,
  handler: async (input, context) => {
    const { gpuTypes } = await context.client.listGpuTypes();
    const filter: GpuFilter = {
      cloud: input.cloud,
      minVramGb: input.min_vram_gb,
      nameContains: input.name_contains,
    };
    const slim = gpuTypes
      .filter((g) => matchesFilter(g as unknown as Record<string, unknown>, filter))
      .map((g) => mapGpuType(g as unknown as Record<string, unknown>, input.cloud))
      .sort(byPriceAsc);
    return { gpuTypes: slim, count: slim.length };
  },
});

// =============================================================================
// cheapest_gpu
// =============================================================================

const cheapestGpuInputSchema = z.object({
  min_vram_gb: z.number().min(0).optional(),
  cloud: cloudEnum.optional().default("ANY"),
  name_contains: z.string().optional(),
  gpu_count: z.number().int().min(1).optional().default(1),
});

type CheapestGpuInput = z.infer<typeof cheapestGpuInputSchema>;

type CheapestGpuOutput = {
  id: string | null;
  displayName: string | null;
  price_per_hr: number | null;
  cloud: Cloud;
  memoryInGb: number | null;
  gpu_count: number;
  estimated_per_hr_total: number | null;
  alternatives: SlimGpuType[];
  note: string;
};

export const cheapestGpu = defineTool<
  CheapestGpuInput,
  CheapestGpuOutput,
  RunpodContext
>({
  name: "cheapest_gpu",
  description: "Find the cheapest GPU matching VRAM and cloud filters.",
  // Cast required: `cloud` and `gpu_count` use `.optional().default(...)`, so
  // the schema's input type is wider than the resolved output type.
  inputSchema: cheapestGpuInputSchema as unknown as z.ZodType<CheapestGpuInput>,
  handler: async (input, context) => {
    const { gpuTypes } = await context.client.listGpuTypes();
    const filter: GpuFilter = {
      cloud: input.cloud,
      minVramGb: input.min_vram_gb,
      nameContains: input.name_contains,
    };
    const matched = gpuTypes
      .filter((g) => matchesFilter(g as unknown as Record<string, unknown>, filter))
      .map((g) => mapGpuType(g as unknown as Record<string, unknown>, input.cloud))
      .sort(byPriceAsc);
    // Only priced GPUs can be "cheapest"; unknown-price matches can't rank.
    const priced = matched.filter((g) => g.pricePerHr !== null);

    if (priced.length === 0) {
      const note =
        matched.length === 0
          ? "No GPU types match the given filters."
          : `Matching GPUs found but none have a known ${input.cloud} price.`;
      return {
        id: null,
        displayName: null,
        price_per_hr: null,
        cloud: input.cloud,
        memoryInGb: null,
        gpu_count: input.gpu_count,
        estimated_per_hr_total: null,
        alternatives: [],
        note,
      };
    }

    const cheapest = priced[0]!;
    const alternatives = priced.slice(1, 5);
    const perHr = cheapest.pricePerHr as number;
    const total = perHr * input.gpu_count;
    return {
      id: cheapest.id,
      displayName: cheapest.displayName,
      price_per_hr: perHr,
      cloud: input.cloud,
      memoryInGb: cheapest.memoryInGb,
      gpu_count: input.gpu_count,
      estimated_per_hr_total: total,
      alternatives,
      note: `Cheapest ${input.cloud} match: ${cheapest.id} at $${perHr}/hr.`,
    };
  },
});

// =============================================================================
// estimate_cost
// =============================================================================

// Hardcoded fallback matching launch_pod's, so estimate_cost prices the same
// GPU a caller would get when neither input.gpu nor RUNPOD_DEFAULT_GPU is set.
const FALLBACK_GPU_ID = "NVIDIA GeForce RTX 4090";

const estimateCostInputSchema = z.object({
  gpu: z.string().min(1).optional(),
  gpu_count: z.number().int().min(1).optional().default(1),
  hours: z.number().min(0).optional().default(1),
  cloud: cloudEnum.optional().default("ANY"),
});

type EstimateCostInput = z.infer<typeof estimateCostInputSchema>;

type EstimateCostOutput = {
  gpu: string;
  gpu_count: number;
  price_per_hr: number | null;
  hours: number;
  estimated_total_usd: number | null;
  cloud: Cloud;
  note: string;
};

export const estimateCost = defineTool<
  EstimateCostInput,
  EstimateCostOutput,
  RunpodContext
>({
  name: "estimate_cost",
  description: "Estimate pod cost before launching.",
  // Cast required: `gpu_count`, `hours`, and `cloud` use `.optional().default(...)`,
  // so the schema's input type is wider than the resolved output type.
  inputSchema: estimateCostInputSchema as unknown as z.ZodType<EstimateCostInput>,
  handler: async (input, context) => {
    // Default-GPU resolution mirrors launch_pod: explicit input → client
    // default → hardcoded fallback.
    const resolvedGpu = input.gpu ?? context.client.defaultGpu ?? FALLBACK_GPU_ID;
    const base = {
      gpu: resolvedGpu,
      gpu_count: input.gpu_count,
      hours: input.hours,
      cloud: input.cloud,
    };

    const { gpuTypes } = await context.client.listGpuTypes();
    const match = gpuTypes.find(
      (g) => (g as unknown as Record<string, unknown>).id === resolvedGpu,
    );

    if (match === undefined) {
      return {
        ...base,
        price_per_hr: null,
        estimated_total_usd: null,
        note: `GPU '${resolvedGpu}' not found in the Runpod pricing table; cannot estimate cost.`,
      };
    }

    const price = priceFor(match as unknown as Record<string, unknown>, input.cloud);
    if (price === null) {
      return {
        ...base,
        price_per_hr: null,
        estimated_total_usd: null,
        note: `No ${input.cloud} price available for '${resolvedGpu}'; cannot estimate cost.`,
      };
    }

    const estimated_total_usd = price * input.gpu_count * input.hours;
    return {
      ...base,
      price_per_hr: price,
      estimated_total_usd,
      note: `${input.gpu_count}x ${resolvedGpu} for ${input.hours}h in ${input.cloud} cloud at $${price}/hr.`,
    };
  },
});
