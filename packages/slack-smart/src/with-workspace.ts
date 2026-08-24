import { z, ZodObject } from "zod";
import type { ToolDefinition } from "smart-mcp-core";
import type { SlackContext } from "./context.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const WORKSPACE_FIELD = "workspace";

const workspaceSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Slack workspace to act in (a configured SLACK_USER_TOKEN_<NAME> suffix, " +
      "case-insensitive). Defaults to SLACK_DEFAULT_WORKSPACE.",
  );

/**
 * Give a tool a `workspace` input and route its call to that workspace's
 * client. Tools keep reading `context.client`; the wrapper swaps it per call,
 * so no tool needs to know several workspaces exist.
 */
export function withWorkspace<Input, Output>(
  tool: ToolDefinition<Input, Output, SlackContext>,
  registry: WorkspaceRegistry,
): ToolDefinition<Input, Output, SlackContext> {
  const schema = tool.inputSchema;
  if (!(schema instanceof ZodObject)) {
    throw new Error(
      `slack-smart tool "${tool.name}" must use a z.object input schema to accept ` +
        `a workspace; got ${schema.constructor.name}`,
    );
  }
  if (WORKSPACE_FIELD in schema.shape) {
    throw new Error(
      `slack-smart tool "${tool.name}" already declares an input named "${WORKSPACE_FIELD}"`,
    );
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema.extend({ [WORKSPACE_FIELD]: workspaceSchema }),
    handler: async (input, context) => {
      const { [WORKSPACE_FIELD]: workspace, ...rest } = input as Record<string, unknown>;
      const client = registry.clientFor(workspace as string | undefined);
      return tool.handler(rest as Input, { ...context, client });
    },
  };
}
