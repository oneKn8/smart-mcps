import type { ToolDefinition } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { whoami } from "./identity.js";

// identity (1)
export const tools: ToolDefinition<unknown, unknown, SlackContext>[] = [
  whoami as unknown as ToolDefinition<unknown, unknown, SlackContext>,
];
