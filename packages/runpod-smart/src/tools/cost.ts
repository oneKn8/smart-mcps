import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import type { BillingRecord } from "../client.js";

// =============================================================================
// cost_audit
// =============================================================================
//
// Aggregates the last N days of Runpod spend across pods, serverless
// endpoints, and network volumes. Numbers come straight from the billing
// REST API, where every `amount` is denominated in USD per the OpenAPI spec
// (https://rest.runpod.io/v1/openapi.json — schema BillingRecord). We don't
// do currency conversion.
//
// Per-pod breakdown is best-effort. Runpod's billing endpoints group records
// by either podId, endpointId, or gpuTypeId depending on the `grouping`
// query param. When records carry `podId` we can rank pods by spend; when
// the API returns gpuType-grouped records (or no podId at all) we surface an
// honest note instead of inventing a breakdown.

const costAuditInputSchema = z.object({
  days: z.number().int().min(1).max(365).optional().default(7),
});

type CostAuditInput = z.infer<typeof costAuditInputSchema>;

type TopPod = {
  pod_id: string;
  name: string | null;
  cost_usd: number;
};

type CostAuditOutput = {
  window_days: number;
  total_usd: number;
  by_resource: {
    pods: number;
    endpoints: number;
    networkvolumes: number;
  };
  top_pods: TopPod[];
  notes: string[];
};

const TOP_POD_LIMIT = 5;

function sumAmount(records: BillingRecord[]): number {
  let total = 0;
  for (const r of records) {
    if (typeof r.amount === "number") total += r.amount;
  }
  return total;
}

function groupByPod(records: BillingRecord[]): Map<string, number> {
  const byPod = new Map<string, number>();
  for (const r of records) {
    const podId = typeof r.podId === "string" ? r.podId : null;
    const amount = typeof r.amount === "number" ? r.amount : 0;
    if (!podId) continue;
    byPod.set(podId, (byPod.get(podId) ?? 0) + amount);
  }
  return byPod;
}

function topPods(records: BillingRecord[]): TopPod[] {
  const byPod = groupByPod(records);
  if (byPod.size === 0) return [];
  return Array.from(byPod.entries())
    .map(([pod_id, cost_usd]) => ({ pod_id, name: null, cost_usd }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, TOP_POD_LIMIT);
}

function buildNotes(args: {
  totalUsd: number;
  pods: number;
  endpoints: number;
  networkvolumes: number;
  windowDays: number;
  hasPodBreakdown: boolean;
  podRecordCount: number;
}): string[] {
  const notes: string[] = [];
  if (args.totalUsd === 0) {
    notes.push(
      `No spend recorded in the last ${args.windowDays} day${args.windowDays === 1 ? "" : "s"}.`,
    );
    return notes;
  }
  if (args.pods > 0) {
    const perDay = args.pods / args.windowDays;
    notes.push(
      `Pods cost $${args.pods.toFixed(2)} over ${args.windowDays} day${args.windowDays === 1 ? "" : "s"} (~$${perDay.toFixed(2)}/day).`,
    );
  }
  if (args.endpoints === 0 && args.totalUsd > 0) {
    notes.push("Serverless endpoints idle (no usage in window).");
  }
  if (args.networkvolumes > args.pods + args.endpoints) {
    notes.push(
      `Storage cost dominant: $${args.networkvolumes.toFixed(2)} of $${args.totalUsd.toFixed(2)} total.`,
    );
  }
  if (args.podRecordCount > 0 && !args.hasPodBreakdown) {
    notes.push(
      "Per-pod cost breakdown unavailable for this window (billing API returned grouped totals).",
    );
  }
  return notes;
}

export const costAudit = defineTool<
  CostAuditInput,
  CostAuditOutput,
  RunpodContext
>({
  name: "cost_audit",
  description:
    "Spend snapshot for pods, serverless, and storage in window.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `days | undefined` but its output type is `number`.
  inputSchema: costAuditInputSchema as unknown as z.ZodType<CostAuditInput>,
  handler: async (input, context) => {
    const now = Date.now();
    const fromMs = now - input.days * 24 * 3600 * 1000;
    const window = {
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
    };

    const [pods, endpoints, networkvolumes] = await Promise.all([
      context.client.getBillingPods(window),
      context.client.getBillingEndpoints(window),
      context.client.getBillingNetworkVolumes(window),
    ]);

    const podsTotal = sumAmount(pods.records);
    const endpointsTotal = sumAmount(endpoints.records);
    const networkVolumesTotal = sumAmount(networkvolumes.records);
    const totalUsd = podsTotal + endpointsTotal + networkVolumesTotal;

    const top = topPods(pods.records);

    return {
      window_days: input.days,
      total_usd: totalUsd,
      by_resource: {
        pods: podsTotal,
        endpoints: endpointsTotal,
        networkvolumes: networkVolumesTotal,
      },
      top_pods: top,
      notes: buildNotes({
        totalUsd,
        pods: podsTotal,
        endpoints: endpointsTotal,
        networkvolumes: networkVolumesTotal,
        windowDays: input.days,
        hasPodBreakdown: top.length > 0,
        podRecordCount: pods.records.length,
      }),
    };
  },
});
