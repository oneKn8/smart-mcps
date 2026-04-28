import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";

// Slim view of a Runpod Serverless Endpoint. Mirrors the camelCase convention
// used by SlimPod / SlimTemplate. Upstream-only fields (env, gpuTypeIds,
// gpuCount, scalerType, scalerValue, computeType, dataCenterIds,
// executionTimeoutMs, workers, allowedCudaVersions, minCudaVersion,
// networkVolumeId, networkVolumeIds, instanceIds, template, userId, version)
// are dropped because they bloat the response without helping the "which
// endpoints do I have?" question this tool answers.
type SlimEndpoint = {
  id: string;
  name: string | null;
  templateId: string | null;
  workersMin: number | null;
  workersMax: number | null;
  idleTimeout: number | null;
  createdAt: string | null;
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function mapEndpoint(e: Record<string, unknown>): SlimEndpoint {
  return {
    id: typeof e.id === "string" ? e.id : "",
    name: nullableString(e.name),
    templateId: nullableString(e.templateId),
    workersMin: nullableNumber(e.workersMin),
    workersMax: nullableNumber(e.workersMax),
    idleTimeout: nullableNumber(e.idleTimeout),
    createdAt: nullableString(e.createdAt),
  };
}

// =============================================================================
// list_endpoints
// =============================================================================

const listEndpointsInputSchema = z.object({});

type ListEndpointsInput = z.infer<typeof listEndpointsInputSchema>;

type ListEndpointsOutput = {
  endpoints: SlimEndpoint[];
  count: number;
};

export const listEndpoints = defineTool<
  ListEndpointsInput,
  ListEndpointsOutput,
  RunpodContext
>({
  name: "list_endpoints",
  description: "List Runpod serverless endpoints.",
  inputSchema: listEndpointsInputSchema,
  handler: async (_input, context) => {
    const { endpoints } = await context.client.listEndpoints();
    return {
      endpoints: endpoints.map((e) =>
        mapEndpoint(e as Record<string, unknown>),
      ),
      count: endpoints.length,
    };
  },
});
