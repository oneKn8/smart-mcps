import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import type { DeploymentConfigInput } from "../client.js";
import { mapVersion, type SlimVersion } from "../version-mapper.js";
import { mapDeployment, type SlimDeployment } from "../deployment-mapper.js";

// =============================================================================
// deploy_script (convenience: create_version THEN create_deployment)
// =============================================================================

const deployScriptInputSchema = z.object({
  script_id: z.string().min(1),
  /** Description recorded on the new version snapshot. */
  version_description: z.string().optional(),
  /** Description recorded on the new deployment. */
  description: z.string().optional(),
  /** Manifest filename; defaults to `appsscript`. */
  manifest_file_name: z.string().optional().default("appsscript"),
});

type DeployScriptInput = z.input<typeof deployScriptInputSchema>;
type DeployScriptParsed = z.infer<typeof deployScriptInputSchema>;
type DeployScriptOutput = {
  version: SlimVersion;
  deployment: SlimDeployment;
};

export const deployScriptTool = defineTool<
  DeployScriptInput,
  DeployScriptOutput,
  AppsScriptContext
>({
  name: "deploy_script",
  description: "Create a version then deploy it",
  // Cast required because `manifest_file_name` has `.optional().default(...)`.
  inputSchema:
    deployScriptInputSchema as unknown as z.ZodType<DeployScriptInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeployScriptParsed;

    // Step 1: snapshot HEAD into a new immutable version.
    const rawVersion = await ctx.client.createVersion(
      parsed.script_id,
      parsed.version_description,
    );
    const version = mapVersion(rawVersion);
    if (version.version_number === null) {
      throw new Error(
        "deploy_script: version creation returned no versionNumber; cannot deploy.",
      );
    }

    // Step 2: deploy that exact version. (Triggers cannot be created via the
    // API — see the README; deploy_script only versions + deploys.)
    const config: DeploymentConfigInput = {
      versionNumber: version.version_number,
      manifestFileName: parsed.manifest_file_name,
    };
    if (parsed.description !== undefined) config.description = parsed.description;
    const rawDeployment = await ctx.client.createDeployment(
      parsed.script_id,
      config,
    );

    return { version, deployment: mapDeployment(rawDeployment) };
  },
});
