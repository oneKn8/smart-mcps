import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";

const inputSchema = z.object({
  status: z.enum(["RUNNING", "STOPPED", "ALL"]).optional().default("ALL"),
});

type Input = z.infer<typeof inputSchema>;

type SlimPod = {
  id: string;
  name: string | null;
  status: string;
  image: string | null;
  gpu: { displayName: string; count: number };
  costPerHr: number;
  adjustedCostPerHr: number;
  lastStartedAt: string | null;
};

type Output = {
  pods: SlimPod[];
  count: number;
};

function pickGpu(pod: Record<string, unknown>): { displayName: string; count: number } {
  const gpuField = pod.gpu;
  const displayName =
    gpuField && typeof gpuField === "object" && gpuField !== null
      ? typeof (gpuField as { displayName?: unknown }).displayName === "string"
        ? ((gpuField as { displayName: string }).displayName)
        : ""
      : "";
  const rawCount = (pod as { gpuCount?: unknown }).gpuCount;
  const count = typeof rawCount === "number" ? rawCount : 0;
  return { displayName, count };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export const listPods = defineTool<Input, Output, RunpodContext>({
  name: "list_pods",
  description: "List all Runpod pods.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `status | undefined` but its output type is the resolved union.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, context) => {
    const { pods } = input.status === "ALL"
      ? await context.client.listPods()
      : await context.client.listPods({ desiredStatus: input.status });

    const slim: SlimPod[] = pods.map((p) => {
      const pod = p as Record<string, unknown>;
      return {
        id: pod.id as string,
        name: nullableString(pod.name),
        status: (pod.desiredStatus as string | undefined) ?? "",
        image: nullableString(pod.image),
        gpu: pickGpu(pod),
        costPerHr: typeof pod.costPerHr === "number" ? (pod.costPerHr as number) : 0,
        adjustedCostPerHr:
          typeof pod.adjustedCostPerHr === "number"
            ? (pod.adjustedCostPerHr as number)
            : 0,
        lastStartedAt: nullableString(pod.lastStartedAt),
      };
    });

    return { pods: slim, count: slim.length };
  },
});
