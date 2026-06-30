import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import type { DeploymentConfigInput } from "../client.js";
import { mapDeployment, type SlimDeployment } from "../deployment-mapper.js";

// =============================================================================
// create_deployment
// =============================================================================

const createDeploymentInputSchema = z.object({
  script_id: z.string().min(1),
  /** Version to publish; omit to deploy HEAD (a dev/test deployment). */
  version_number: z.number().int().optional(),
  /** Manifest filename; defaults to `appsscript`. */
  manifest_file_name: z.string().optional().default("appsscript"),
  description: z.string().optional(),
});

type CreateDeploymentInput = z.input<typeof createDeploymentInputSchema>;
type CreateDeploymentParsed = z.infer<typeof createDeploymentInputSchema>;
type CreateDeploymentOutput = { deployment: SlimDeployment };

function buildConfig(parsed: {
  version_number?: number;
  manifest_file_name?: string;
  description?: string;
}): DeploymentConfigInput {
  const config: DeploymentConfigInput = {};
  if (parsed.version_number !== undefined) {
    config.versionNumber = parsed.version_number;
  }
  if (parsed.manifest_file_name !== undefined) {
    config.manifestFileName = parsed.manifest_file_name;
  }
  if (parsed.description !== undefined) config.description = parsed.description;
  return config;
}

export const createDeploymentTool = defineTool<
  CreateDeploymentInput,
  CreateDeploymentOutput,
  AppsScriptContext
>({
  name: "create_deployment",
  description: "Create a deployment",
  // Cast required because `manifest_file_name` has `.optional().default(...)`.
  inputSchema:
    createDeploymentInputSchema as unknown as z.ZodType<CreateDeploymentInput>,
  handler: async (input, ctx) => {
    const parsed = input as CreateDeploymentParsed;
    const raw = await ctx.client.createDeployment(
      parsed.script_id,
      buildConfig(parsed),
    );
    return { deployment: mapDeployment(raw) };
  },
});

// =============================================================================
// list_deployments
// =============================================================================

const listDeploymentsInputSchema = z.object({
  script_id: z.string().min(1),
  page_size: z.number().int().positive().optional(),
  page_token: z.string().optional(),
});

type ListDeploymentsInput = z.infer<typeof listDeploymentsInputSchema>;
type ListDeploymentsOutput = {
  deployments: SlimDeployment[];
  next_page_token: string | null;
};

export const listDeploymentsTool = defineTool<
  ListDeploymentsInput,
  ListDeploymentsOutput,
  AppsScriptContext
>({
  name: "list_deployments",
  description: "List a project's deployments",
  inputSchema: listDeploymentsInputSchema,
  handler: async (input, ctx) => {
    const res = await ctx.client.listDeployments({
      scriptId: input.script_id,
      ...(input.page_size !== undefined ? { pageSize: input.page_size } : {}),
      ...(input.page_token !== undefined
        ? { pageToken: input.page_token }
        : {}),
    });
    return {
      deployments: res.items.map(mapDeployment),
      next_page_token: res.nextPageToken ?? null,
    };
  },
});

// =============================================================================
// get_deployment
// =============================================================================

const getDeploymentInputSchema = z.object({
  script_id: z.string().min(1),
  deployment_id: z.string().min(1),
});

type GetDeploymentInput = z.infer<typeof getDeploymentInputSchema>;
type GetDeploymentOutput = { deployment: SlimDeployment };

export const getDeploymentTool = defineTool<
  GetDeploymentInput,
  GetDeploymentOutput,
  AppsScriptContext
>({
  name: "get_deployment",
  description: "Get one deployment",
  inputSchema: getDeploymentInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getDeployment(
      input.script_id,
      input.deployment_id,
    );
    return { deployment: mapDeployment(raw) };
  },
});

// =============================================================================
// update_deployment
// =============================================================================

const updateDeploymentInputSchema = z.object({
  script_id: z.string().min(1),
  deployment_id: z.string().min(1),
  version_number: z.number().int().optional(),
  manifest_file_name: z.string().optional().default("appsscript"),
  description: z.string().optional(),
});

type UpdateDeploymentInput = z.input<typeof updateDeploymentInputSchema>;
type UpdateDeploymentParsed = z.infer<typeof updateDeploymentInputSchema>;
type UpdateDeploymentOutput = { deployment: SlimDeployment };

export const updateDeploymentTool = defineTool<
  UpdateDeploymentInput,
  UpdateDeploymentOutput,
  AppsScriptContext
>({
  name: "update_deployment",
  description: "Update a deployment's config",
  // Cast required because `manifest_file_name` has `.optional().default(...)`.
  inputSchema:
    updateDeploymentInputSchema as unknown as z.ZodType<UpdateDeploymentInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateDeploymentParsed;
    const raw = await ctx.client.updateDeployment(
      parsed.script_id,
      parsed.deployment_id,
      buildConfig(parsed),
    );
    return { deployment: mapDeployment(raw) };
  },
});

// =============================================================================
// delete_deployment (destructive — confirm-gated)
// =============================================================================

const deleteDeploymentInputSchema = z.object({
  script_id: z.string().min(1),
  deployment_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteDeploymentInput = z.input<typeof deleteDeploymentInputSchema>;
type DeleteDeploymentParsed = z.infer<typeof deleteDeploymentInputSchema>;
type DeleteDeploymentOutput = { deleted: true };

export const deleteDeploymentTool = defineTool<
  DeleteDeploymentInput,
  DeleteDeploymentOutput,
  AppsScriptContext
>({
  name: "delete_deployment",
  description: "Delete a deployment permanently",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    deleteDeploymentInputSchema as unknown as z.ZodType<DeleteDeploymentInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteDeploymentParsed;
    const preview =
      `Delete deployment ${parsed.deployment_id} from project ${parsed.script_id}. ` +
      "Any web app / API Executable URL it serves stops responding.";
    guardDestructive({ confirm: parsed.confirm, preview });
    await ctx.client.deleteDeployment(parsed.script_id, parsed.deployment_id);
    return { deleted: true };
  },
});
