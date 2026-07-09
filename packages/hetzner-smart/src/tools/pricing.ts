import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import {
  rankServerTypes,
  priceForServerType,
  firstPrice,
  parseNet,
  parseDecimal,
  roundMonthly,
  type PricedType,
} from "./pricing-util.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function currencyOf(pricing: { currency?: unknown }): string {
  return typeof pricing.currency === "string" && pricing.currency.length > 0
    ? pricing.currency
    : "EUR";
}

// =============================================================================
// cheapest_server_type — rank matching server types cheapest-monthly first.
// =============================================================================

const cheapestServerTypeInputSchema = z.object({
  min_cores: z.number().int().positive().optional(),
  min_memory: z.number().positive().optional(),
  arch: z.enum(["x86", "arm"]).optional().default("x86"),
  cpu_type: z.enum(["shared", "dedicated"]).optional(),
  location: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional().default(5),
});

type CheapestServerTypeInput = z.infer<typeof cheapestServerTypeInputSchema>;

type CheapestServerTypeOutput = {
  server_types: PricedType[];
  count: number;
  currency: string;
};

export const cheapestServerType = defineTool<
  CheapestServerTypeInput,
  CheapestServerTypeOutput,
  HetznerContext
>({
  name: "cheapest_server_type",
  description: "Rank server types by monthly price with filters.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    cheapestServerTypeInputSchema as unknown as z.ZodType<CheapestServerTypeInput>,
  handler: async (input, context) => {
    // availableOnly cross-checks /datacenters so we never surface a (type,
    // location) pair that is priced but not actually orderable (would 422 on
    // create). With a pinned location only orderable types survive; without one
    // each type resolves to its cheapest ORDERABLE location.
    const ranked = await rankServerTypes(context.client, {
      min_cores: input.min_cores,
      min_memory: input.min_memory,
      arch: input.arch,
      cpu_type: input.cpu_type,
      location: input.location,
      availableOnly: true,
    });
    const pricing = await context.client.getPricing();
    const top = ranked.slice(0, input.limit);
    return {
      server_types: top,
      count: top.length,
      currency: currencyOf(pricing),
    };
  },
});

// =============================================================================
// estimate_cost — monthly + multi-month total for a server + add-ons.
// =============================================================================

const estimateCostInputSchema = z.object({
  server_type: z.string().min(1),
  location: z.string().min(1).optional(),
  volumes_gb: z.number().min(0).optional().default(0),
  primary_ipv4: z.boolean().optional().default(true),
  backups: z.boolean().optional().default(false),
  months: z.number().positive().optional().default(1),
});

type EstimateCostInput = z.infer<typeof estimateCostInputSchema>;

type EstimateCostOutput = {
  currency: string;
  server_type: string;
  location: string | null;
  monthly: {
    server: number | null;
    volume: number;
    primary_ipv4: number;
    backups: number;
    total: number;
  };
  total_for_months: number;
  months: number;
};

export const estimateCost = defineTool<
  EstimateCostInput,
  EstimateCostOutput,
  HetznerContext
>({
  name: "estimate_cost",
  description: "Estimate monthly cost for a server plus add-ons.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: estimateCostInputSchema as unknown as z.ZodType<EstimateCostInput>,
  handler: async (input, context) => {
    const pricing = await context.client.getPricing();

    const serverPrice = priceForServerType(
      pricing,
      input.server_type,
      input.location,
    );
    const server =
      serverPrice.monthly === null ? null : roundMonthly(serverPrice.monthly);

    const perGb = parseNet(asRecord(pricing.volume)?.price_per_gb_month) ?? 0;
    const volume = roundMonthly(perGb * input.volumes_gb);

    let primaryIpv4 = 0;
    if (input.primary_ipv4) {
      const p = firstPrice(pricing.primary_ips, "ipv4", input.location);
      primaryIpv4 = p === null ? 0 : roundMonthly(p);
    }

    let backups = 0;
    if (input.backups && server !== null) {
      const pct =
        parseDecimal(asRecord(pricing.server_backup)?.percentage) ?? 0;
      backups = roundMonthly((server * pct) / 100);
    }

    const total = roundMonthly(
      (server ?? 0) + volume + primaryIpv4 + backups,
    );
    const total_for_months = roundMonthly(total * input.months);

    return {
      currency: currencyOf(pricing),
      server_type: input.server_type,
      location: input.location ?? null,
      monthly: { server, volume, primary_ipv4: primaryIpv4, backups, total },
      total_for_months,
      months: input.months,
    };
  },
});
