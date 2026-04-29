import type { ToolDefinition } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { sendEmail } from "./send.js";
import { sendWithTemplate } from "./send-template.js";

export const tools: ToolDefinition<unknown, unknown, EmailContext>[] = [
  sendEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  sendWithTemplate as unknown as ToolDefinition<unknown, unknown, EmailContext>,
];
