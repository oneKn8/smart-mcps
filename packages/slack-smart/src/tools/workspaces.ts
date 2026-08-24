import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { tokenKind } from "../workspaces.js";

const inputSchema = z.object({
  check: z
    .boolean()
    .optional()
    .default(true)
    .describe("Call auth.test on every workspace so dead tokens show up here."),
});

type Input = z.infer<typeof inputSchema>;

type WorkspaceStatus = {
  name: string;
  default: boolean;
  token_kind: "oauth" | "session";
  has_bot_token: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  url?: string;
  error?: string;
};

type Output = { workspaces: WorkspaceStatus[] };

export const list_workspaces = defineTool<Input, Output, SlackContext>({
  name: "list_workspaces",
  description:
    "List configured Slack workspaces and whether each token still works.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, context) => {
    const registry = context.workspaces;
    const workspaces: WorkspaceStatus[] = [];
    for (const name of registry.names()) {
      const entry = registry.entry(name);
      const status: WorkspaceStatus = {
        name,
        default: name === registry.defaultName,
        token_kind: tokenKind(entry.userToken),
        has_bot_token: entry.botToken !== undefined,
      };
      if (input.check) {
        try {
          const id = await registry.clientFor(name).authTest("user");
          status.team = id.team;
          status.team_id = id.team_id;
          status.user = id.user;
          status.user_id = id.user_id;
          status.url = id.url;
        } catch (err) {
          status.error = err instanceof Error ? err.message : String(err);
        }
      }
      workspaces.push(status);
    }
    return { workspaces };
  },
});
