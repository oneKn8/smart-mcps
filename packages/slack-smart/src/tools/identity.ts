import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { SlackContext } from "../context.js";

const inputSchema = z.object({
  token: z.enum(["user", "bot"]).optional().default("user"),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  user_id: string;
  user: string;
  team_id: string;
  team: string;
  url: string;
  bot_id?: string;
};

export const whoami = defineTool<Input, Output, SlackContext>({
  name: "whoami",
  description: "Show the authenticated Slack user and workspace.",
  // Cast required: z.ZodType<Input> is invariant; ZodDefault's input type is
  // `"user" | "bot" | undefined` but its output type is `"user" | "bot"`.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, context) => {
    const id = await context.client.authTest(input.token);
    return {
      user_id: id.user_id,
      user: id.user,
      team_id: id.team_id,
      team: id.team,
      url: id.url,
      ...(id.bot_id !== undefined ? { bot_id: id.bot_id } : {}),
    };
  },
});
