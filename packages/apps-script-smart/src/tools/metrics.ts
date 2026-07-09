import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { resolveAccount } from "./account.js";
import { mapMetrics, type SlimMetrics } from "../metrics-mapper.js";

const granularitySchema = z.enum(["DAILY", "WEEKLY"]);

const getMetricsInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  script_id: z.string().min(1),
  /** `DAILY` (over a 7-day period) or `WEEKLY`. Defaults to `DAILY`. */
  granularity: granularitySchema.optional().default("DAILY"),
  /** Narrow the metrics to a single deployment. */
  deployment_id: z.string().optional(),
});

type GetMetricsInput = z.input<typeof getMetricsInputSchema>;
type GetMetricsParsed = z.infer<typeof getMetricsInputSchema>;
type GetMetricsOutput = { metrics: SlimMetrics };

export const getMetricsTool = defineTool<
  GetMetricsInput,
  GetMetricsOutput,
  AppsScriptContext
>({
  name: "get_metrics",
  description: "Get project execution metrics",
  // Cast required because `granularity` has `.optional().default(...)`.
  inputSchema: getMetricsInputSchema as unknown as z.ZodType<GetMetricsInput>,
  handler: async (input, ctx) => {
    const parsed = input as GetMetricsParsed;
    const account = resolveAccount(parsed.account, ctx);
    const raw = await ctx.client.getMetrics(account, {
      scriptId: parsed.script_id,
      metricsGranularity: parsed.granularity,
      ...(parsed.deployment_id !== undefined
        ? { deploymentId: parsed.deployment_id }
        : {}),
    });
    return { metrics: mapMetrics(raw) };
  },
});
