import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { mapPod, type SlimPod } from "./pod-mapper.js";

const inputSchema = z.object({
  status: z.enum(["RUNNING", "STOPPED", "ALL"]).optional().default("ALL"),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  pods: SlimPod[];
  count: number;
};

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

    return {
      pods: pods.map((p) => mapPod(p as Record<string, unknown>)),
      count: pods.length,
    };
  },
});
