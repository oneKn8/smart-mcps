import type { ToolDefinition } from "smart-mcp-core";
import type { SlackContext } from "../context.js";

// Tools are appended here incrementally per build task.
export const tools: ToolDefinition<unknown, unknown, SlackContext>[] = [];
