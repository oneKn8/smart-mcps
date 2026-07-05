import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";

// Serverless job submission host. The run_url handed back to the caller points
// here (api.runpod.ai/v2/<endpointId>/run), NOT at the REST management host
// that created the endpoint.
const INFERENCE_BASE = "https://api.runpod.ai/v2";

// =============================================================================
// deploy_serverless
// =============================================================================

const deployServerlessInputSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  gpu_type_ids: z.array(z.string()).optional(),
  gpu_count: z.number().int().min(1).optional(),
  workers_min: z.number().int().min(0).optional(),
  workers_max: z.number().int().min(1).optional(),
  idle_timeout: z.number().int().min(0).optional(),
  container_disk_gb: z.number().int().min(1).optional(),
  volume_gb: z.number().int().min(0).optional(),
  env: z.record(z.string(), z.string()).optional(),
  container_registry_auth_id: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type DeployServerlessInput = z.infer<typeof deployServerlessInputSchema>;

type DeployServerlessOutput = {
  template_id: string;
  endpoint_id: string;
  name: string;
  run_url: string;
};

export const deployServerless = defineTool<
  DeployServerlessInput,
  DeployServerlessOutput,
  RunpodContext
>({
  name: "deploy_serverless",
  description: "Create a template and serverless endpoint together.",
  // Cast required: `confirm` uses `.optional().default(false)`, so the schema's
  // input type (with `confirm | undefined`) is wider than the resolved output
  // type the handler actually receives.
  inputSchema: deployServerlessInputSchema as unknown as z.ZodType<DeployServerlessInput>,
  handler: async (input, context) => {
    // Single confirm gate up front: both the template and the endpoint are
    // created as one logical action, so we guard once before any side effect.
    const preview = `Will create serverless template + endpoint ${input.name} from ${input.image}`;
    guardDestructive({ confirm: input.confirm, preview });

    // Step 1: create the backing template. Only forward fields the caller set;
    // omitting undefined keeps upstream defaults intact.
    const templateBody: Record<string, unknown> = {
      name: input.name,
      imageName: input.image,
      isServerless: true,
    };
    if (input.container_disk_gb !== undefined) {
      templateBody.containerDiskInGb = input.container_disk_gb;
    }
    if (input.volume_gb !== undefined) {
      templateBody.volumeInGb = input.volume_gb;
    }
    if (input.env !== undefined) templateBody.env = input.env;
    if (input.container_registry_auth_id !== undefined) {
      templateBody.containerRegistryAuthId = input.container_registry_auth_id;
    }

    const template = await context.client.createTemplate(templateBody);
    const templateId = typeof template.id === "string" ? template.id : "";

    // Step 2: create the endpoint bound to the fresh template. If this throws,
    // the template already exists — surface its id so the caller can clean up
    // (or reuse it) rather than leaving a silently orphaned template.
    const endpointBody: Record<string, unknown> = {
      templateId,
      name: input.name,
    };
    if (input.gpu_type_ids !== undefined) {
      endpointBody.gpuTypeIds = input.gpu_type_ids;
    }
    if (input.gpu_count !== undefined) endpointBody.gpuCount = input.gpu_count;
    if (input.workers_min !== undefined) {
      endpointBody.workersMin = input.workers_min;
    }
    if (input.workers_max !== undefined) {
      endpointBody.workersMax = input.workers_max;
    }
    if (input.idle_timeout !== undefined) {
      endpointBody.idleTimeout = input.idle_timeout;
    }

    let endpoint: Record<string, unknown>;
    try {
      endpoint = await context.client.createEndpoint(endpointBody);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Endpoint creation failed after template ${templateId} was created ` +
          `(orphaned template — delete or reuse it): ${detail}`,
      );
    }

    const endpointId = typeof endpoint.id === "string" ? endpoint.id : "";

    return {
      template_id: templateId,
      endpoint_id: endpointId,
      name: input.name,
      run_url: `${INFERENCE_BASE}/${endpointId}/run`,
    };
  },
});
