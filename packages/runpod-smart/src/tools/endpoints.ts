import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

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

// =============================================================================
// create_endpoint
// =============================================================================

const createEndpointInputSchema = z.object({
  template_id: z.string().min(1),
  name: z.string().min(1).optional(),
  compute_type: z.enum(["GPU", "CPU"]).optional(),
  gpu_type_ids: z.array(z.string()).optional(),
  gpu_count: z.number().int().min(1).optional(),
  workers_min: z.number().int().min(0).optional(),
  workers_max: z.number().int().min(0).optional(),
  idle_timeout: z.number().int().min(0).optional(),
  scaler_type: z.enum(["QUEUE_DELAY", "REQUEST_COUNT"]).optional(),
  scaler_value: z.number().int().min(0).optional(),
  execution_timeout_ms: z.number().int().min(0).optional(),
  flashboot: z.boolean().optional(),
  network_volume_id: z.string().optional(),
  data_center_ids: z.array(z.string()).optional(),
  confirm: z.boolean().optional().default(false),
});

type CreateEndpointInput = z.infer<typeof createEndpointInputSchema>;

export const createEndpoint = defineTool<
  CreateEndpointInput,
  SlimEndpoint,
  RunpodContext
>({
  name: "create_endpoint",
  description: "Create a serverless endpoint from a template.",
  // Cast required: `confirm` uses `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: createEndpointInputSchema as unknown as z.ZodType<CreateEndpointInput>,
  handler: async (input, context) => {
    const preview =
      input.name !== undefined
        ? `Will create endpoint ${input.name}`
        : `Will create endpoint from template ${input.template_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    // Only send fields the caller provided (omit undefined). templateId is
    // always present because template_id is required.
    const body: Record<string, unknown> = { templateId: input.template_id };
    if (input.name !== undefined) body.name = input.name;
    if (input.compute_type !== undefined) body.computeType = input.compute_type;
    if (input.gpu_type_ids !== undefined) body.gpuTypeIds = input.gpu_type_ids;
    if (input.gpu_count !== undefined) body.gpuCount = input.gpu_count;
    if (input.workers_min !== undefined) body.workersMin = input.workers_min;
    if (input.workers_max !== undefined) body.workersMax = input.workers_max;
    if (input.idle_timeout !== undefined) body.idleTimeout = input.idle_timeout;
    if (input.scaler_type !== undefined) body.scalerType = input.scaler_type;
    if (input.scaler_value !== undefined) body.scalerValue = input.scaler_value;
    if (input.execution_timeout_ms !== undefined) {
      body.executionTimeoutMs = input.execution_timeout_ms;
    }
    if (input.flashboot !== undefined) body.flashboot = input.flashboot;
    if (input.network_volume_id !== undefined) {
      body.networkVolumeId = input.network_volume_id;
    }
    if (input.data_center_ids !== undefined) {
      body.dataCenterIds = input.data_center_ids;
    }

    const created = await context.client.createEndpoint(body);
    return mapEndpoint(created as Record<string, unknown>);
  },
});

// =============================================================================
// get_endpoint
// =============================================================================

const getEndpointInputSchema = z.object({
  endpoint_id: z.string().min(1),
  include_template: z.boolean().optional(),
  include_workers: z.boolean().optional(),
});

type GetEndpointInput = z.infer<typeof getEndpointInputSchema>;

export const getEndpoint = defineTool<
  GetEndpointInput,
  SlimEndpoint,
  RunpodContext
>({
  name: "get_endpoint",
  description: "Get a serverless endpoint by ID.",
  inputSchema: getEndpointInputSchema,
  handler: async (input, context) => {
    const endpoint = await context.client.getEndpoint(input.endpoint_id, {
      includeTemplate: input.include_template,
      includeWorkers: input.include_workers,
    });
    return mapEndpoint(endpoint as Record<string, unknown>);
  },
});

// =============================================================================
// update_endpoint
// =============================================================================

const updateEndpointInputSchema = z.object({
  endpoint_id: z.string().min(1),
  name: z.string().min(1).optional(),
  gpu_type_ids: z.array(z.string()).optional(),
  gpu_count: z.number().int().min(1).optional(),
  workers_min: z.number().int().min(0).optional(),
  workers_max: z.number().int().min(0).optional(),
  idle_timeout: z.number().int().min(0).optional(),
  scaler_type: z.enum(["QUEUE_DELAY", "REQUEST_COUNT"]).optional(),
  scaler_value: z.number().int().min(0).optional(),
  execution_timeout_ms: z.number().int().min(0).optional(),
  flashboot: z.boolean().optional(),
  confirm: z.boolean().optional().default(false),
});

type UpdateEndpointInput = z.infer<typeof updateEndpointInputSchema>;

export const updateEndpoint = defineTool<
  UpdateEndpointInput,
  SlimEndpoint,
  RunpodContext
>({
  name: "update_endpoint",
  description: "Update endpoint scaling and config.",
  // Cast required: `confirm` uses `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: updateEndpointInputSchema as unknown as z.ZodType<UpdateEndpointInput>,
  handler: async (input, context) => {
    // Only send fields the caller provided (omit undefined). endpoint_id is
    // the path id and confirm is control-only — neither belongs in the body.
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.gpu_type_ids !== undefined) body.gpuTypeIds = input.gpu_type_ids;
    if (input.gpu_count !== undefined) body.gpuCount = input.gpu_count;
    if (input.workers_min !== undefined) body.workersMin = input.workers_min;
    if (input.workers_max !== undefined) body.workersMax = input.workers_max;
    if (input.idle_timeout !== undefined) body.idleTimeout = input.idle_timeout;
    if (input.scaler_type !== undefined) body.scalerType = input.scaler_type;
    if (input.scaler_value !== undefined) body.scalerValue = input.scaler_value;
    if (input.execution_timeout_ms !== undefined) {
      body.executionTimeoutMs = input.execution_timeout_ms;
    }
    if (input.flashboot !== undefined) body.flashboot = input.flashboot;

    const changed = Object.keys(body);
    const preview = `Will update endpoint ${input.endpoint_id} (${changed.join(", ")})`;
    guardDestructive({ confirm: input.confirm, preview });

    const updated = await context.client.updateEndpoint(input.endpoint_id, body);
    return mapEndpoint(updated as Record<string, unknown>);
  },
});

// =============================================================================
// delete_endpoint
// =============================================================================

const deleteEndpointInputSchema = z.object({
  endpoint_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteEndpointInput = z.infer<typeof deleteEndpointInputSchema>;

type DeleteEndpointOutput = {
  endpoint_id: string;
  deleted: true;
};

export const deleteEndpoint = defineTool<
  DeleteEndpointInput,
  DeleteEndpointOutput,
  RunpodContext
>({
  name: "delete_endpoint",
  description: "Delete a serverless endpoint.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema: deleteEndpointInputSchema as unknown as z.ZodType<DeleteEndpointInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE endpoint ${input.endpoint_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteEndpoint(input.endpoint_id);
    return { endpoint_id: input.endpoint_id, deleted: true };
  },
});
