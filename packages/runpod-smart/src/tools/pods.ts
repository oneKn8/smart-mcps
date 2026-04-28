import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { mapPod, type SlimPod } from "./pod-mapper.js";

// =============================================================================
// list_pods
// =============================================================================

const listPodsInputSchema = z.object({
  status: z.enum(["RUNNING", "STOPPED", "ALL"]).optional().default("ALL"),
});

type ListPodsInput = z.infer<typeof listPodsInputSchema>;

type ListPodsOutput = {
  pods: SlimPod[];
  count: number;
};

export const listPods = defineTool<ListPodsInput, ListPodsOutput, RunpodContext>({
  name: "list_pods",
  description: "List all Runpod pods.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `status | undefined` but its output type is the resolved union.
  inputSchema: listPodsInputSchema as unknown as z.ZodType<ListPodsInput>,
  handler: async (input, context) => {
    const { pods } = input.status === "ALL"
      ? await context.client.listPods()
      : await context.client.listPods({ desiredStatus: input.status });

    return {
      pods: pods.map((p) => mapPod(p as Record<string, unknown>)),
      count: pods.length,
    };
  },
});

// =============================================================================
// Single-pod tools — shared helpers
// =============================================================================

const podIdSchema = z.string().min(1);

const podActionInputSchema = z.object({
  pod_id: podIdSchema,
  confirm: z.boolean().optional().default(false),
});

type PodActionInput = z.infer<typeof podActionInputSchema>;

// Cost may be a number or absent. We render `~$?/hr` for unknown so previews
// never claim a pod is free when the upstream simply didn't return cost.
function renderCost(pod: Record<string, unknown>): string {
  const value = pod.costPerHr;
  return typeof value === "number" ? `~$${value}/hr` : "~$?/hr";
}

// =============================================================================
// get_pod
// =============================================================================

const getPodInputSchema = z.object({
  pod_id: podIdSchema,
});

type GetPodInput = z.infer<typeof getPodInputSchema>;

export const getPod = defineTool<GetPodInput, SlimPod, RunpodContext>({
  name: "get_pod",
  description: "Get a single Runpod pod by ID.",
  inputSchema: getPodInputSchema,
  handler: async (input, context) => {
    const pod = await context.client.getPod(input.pod_id);
    return mapPod(pod as Record<string, unknown>);
  },
});

// =============================================================================
// start_pod
// =============================================================================

export const startPod = defineTool<PodActionInput, SlimPod, RunpodContext>({
  name: "start_pod",
  description: "Start a stopped Runpod pod.",
  inputSchema: podActionInputSchema as unknown as z.ZodType<PodActionInput>,
  handler: async (input, context) => {
    const current = await context.client.getPod(input.pod_id);
    const cost = renderCost(current as Record<string, unknown>);
    const preview = `Will start pod ${input.pod_id} (${cost})`;
    guardDestructive({ confirm: input.confirm, preview });

    const updated = await context.client.startPod(input.pod_id);
    return mapPod(updated as Record<string, unknown>);
  },
});

// =============================================================================
// stop_pod
// =============================================================================

export const stopPod = defineTool<PodActionInput, SlimPod, RunpodContext>({
  name: "stop_pod",
  description: "Stop a running Runpod pod.",
  inputSchema: podActionInputSchema as unknown as z.ZodType<PodActionInput>,
  handler: async (input, context) => {
    const current = await context.client.getPod(input.pod_id);
    const cost = renderCost(current as Record<string, unknown>);
    const preview = `Will stop pod ${input.pod_id} (${cost})`;
    guardDestructive({ confirm: input.confirm, preview });

    const updated = await context.client.stopPod(input.pod_id);
    return mapPod(updated as Record<string, unknown>);
  },
});

// =============================================================================
// terminate_pod
// =============================================================================

type TerminatePodOutput = {
  pod_id: string;
  terminated: true;
};

export const terminatePod = defineTool<PodActionInput, TerminatePodOutput, RunpodContext>({
  name: "terminate_pod",
  description: "Permanently delete a Runpod pod.",
  inputSchema: podActionInputSchema as unknown as z.ZodType<PodActionInput>,
  handler: async (input, context) => {
    const current = await context.client.getPod(input.pod_id);
    const cost = renderCost(current as Record<string, unknown>);
    const preview = `Will PERMANENTLY DELETE pod ${input.pod_id} (current ${cost})`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.terminatePod(input.pod_id);
    return { pod_id: input.pod_id, terminated: true };
  },
});
