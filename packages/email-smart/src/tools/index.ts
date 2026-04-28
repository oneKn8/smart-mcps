import type { ToolDefinition } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { sendEmail } from "./send.js";

export const tools: ToolDefinition<unknown, unknown, EmailContext>[] = [
  sendEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
];
