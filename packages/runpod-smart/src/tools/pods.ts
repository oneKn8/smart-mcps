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

// =============================================================================
// launch_pod
// =============================================================================

// Hardcoded fallback when neither input.gpu nor RUNPOD_DEFAULT_GPU is set.
// Picked because RTX 4090 is a common, widely-available SECURE/COMMUNITY SKU.
const FALLBACK_GPU_ID = "NVIDIA GeForce RTX 4090";

const launchPodInputSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  gpu: z.string().min(1).optional(),
  gpu_count: z.number().int().min(1).max(8).optional().default(1),
  cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional().default("SECURE"),
  container_disk_gb: z.number().int().min(5).max(2000).optional().default(50),
  volume_gb: z.number().int().min(0).max(10000).optional().default(0),
  volume_mount_path: z.string().optional().default("/workspace"),
  ports: z.array(z.string()).optional().default(["8888/http", "22/tcp"]),
  env: z.record(z.string(), z.string()).optional(),
  template_id: z.string().optional(),
  interruptible: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type LaunchPodInput = z.infer<typeof launchPodInputSchema>;

type LaunchPodOutput = SlimPod & {
  connect_hint: string;
};

export const launchPod = defineTool<LaunchPodInput, LaunchPodOutput, RunpodContext>({
  name: "launch_pod",
  description: "Launch a new GPU pod with image, GPU type, and resource config.",
  // Cast required: many fields use `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: launchPodInputSchema as unknown as z.ZodType<LaunchPodInput>,
  handler: async (input, context) => {
    // Default-GPU resolution: explicit input → client.defaultGpu → fallback.
    const resolvedGpu = input.gpu ?? context.client.defaultGpu ?? FALLBACK_GPU_ID;

    // Cost cannot be known until the pod actually exists (REST API has no
    // pre-flight pricing endpoint). Be honest in the preview rather than
    // fabricate a number from a stale GPU price table.
    const preview =
      `Will launch ${input.name} on ${resolvedGpu}x${input.gpu_count} ` +
      `in ${input.cloud_type} cloud (cost shown after creation)`;
    guardDestructive({ confirm: input.confirm, preview });

    // Build the wire payload. We omit fields whose default is "no-op" rather
    // than sending defaults explicitly — keeps requests minimal and lets the
    // upstream API's own defaults govern in case they change.
    const body: Record<string, unknown> = {
      name: input.name,
      imageName: input.image,
      gpuTypeIds: [resolvedGpu],
      gpuCount: input.gpu_count,
      cloudType: input.cloud_type,
      containerDiskInGb: input.container_disk_gb,
      ports: input.ports,
      interruptible: input.interruptible,
    };
    if (input.volume_gb > 0) {
      body.volumeInGb = input.volume_gb;
      body.volumeMountPath = input.volume_mount_path;
    }
    if (input.env !== undefined) body.env = input.env;
    if (input.template_id !== undefined) body.templateId = input.template_id;

    const created = await context.client.createPod(body);
    const slim = mapPod(created as Record<string, unknown>);

    // At create-time the pod has no IP yet (status is CREATED/PENDING), so
    // we can't render real SSH info. Give an honest, copy-pasteable hint.
    const connect_hint =
      `Pod is starting. Once running: runpodctl exec --pod ${slim.id} bash`;

    return { ...slim, connect_hint };
  },
});
