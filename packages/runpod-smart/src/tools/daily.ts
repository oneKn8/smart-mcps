import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import type { BillingRecord } from "../client.js";
import { mapPod, type SlimPod } from "./pod-mapper.js";

// =============================================================================
// daily_status
// =============================================================================
//
// Mirrors vercel-smart's `daily_status`: gives a single-shot answer to the
// "what's running and is anything odd?" question. We list active (RUNNING)
// pods, total their billing for the chosen window, and flag any pod that's
// been running longer than the window without a restart.
//
// Note on flagging: Runpod's REST API doesn't expose live GPU utilization,
// so we can't detect truly idle pods. We approximate with "running for
// longer than the window" — a pod left up across a full window without a
// restart is the most actionable signal we can extract from REST alone.

const dailyStatusInputSchema = z.object({
  hours: z.number().int().min(1).max(168).optional().default(24),
});

type DailyStatusInput = z.infer<typeof dailyStatusInputSchema>;

type Flag = {
  pod_id: string;
  reason: string;
};

type DailyStatusOutput = {
  window_hours: number;
  active_pods: SlimPod[];
  total_cost_usd_window: number;
  flagged: Flag[];
};

function sumAmount(records: BillingRecord[]): number {
  let total = 0;
  for (const r of records) {
    if (typeof r.amount === "number") total += r.amount;
  }
  return total;
}

export const dailyStatus = defineTool<
  DailyStatusInput,
  DailyStatusOutput,
  RunpodContext
>({
  name: "daily_status",
  description: "Active pods + last 24h cost + flagged resources.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `hours | undefined` but its output type is `number`.
  inputSchema:
    dailyStatusInputSchema as unknown as z.ZodType<DailyStatusInput>,
  handler: async (input, context) => {
    const now = Date.now();
    const cutoffMs = now - input.hours * 3600 * 1000;
    const window = {
      from: new Date(cutoffMs).toISOString(),
      to: new Date(now).toISOString(),
    };

    const [pods, billing] = await Promise.all([
      context.client.listPods({ desiredStatus: "RUNNING" }),
      context.client.getBillingPods(window),
    ]);

    const activePods: SlimPod[] = pods.pods.map((p) =>
      mapPod(p as Record<string, unknown>),
    );

    const flagged: Flag[] = [];
    for (const raw of pods.pods) {
      const pod = raw as Record<string, unknown>;
      const id = typeof pod.id === "string" ? pod.id : null;
      const lastStartedAt =
        typeof pod.lastStartedAt === "string" ? pod.lastStartedAt : null;
      if (!id || !lastStartedAt) continue;
      const startedMs = Date.parse(lastStartedAt);
      if (!Number.isFinite(startedMs)) continue;
      if (startedMs < cutoffMs) {
        flagged.push({
          pod_id: id,
          reason: `Running longer than ${input.hours}h without restart`,
        });
      }
    }

    return {
      window_hours: input.hours,
      active_pods: activePods,
      total_cost_usd_window: sumAmount(billing.records),
      flagged,
    };
  },
});
