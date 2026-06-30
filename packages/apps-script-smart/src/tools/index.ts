import type { ToolDefinition } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";

/**
 * Registry of every apps-script-smart tool. Empty for now — the implementer
 * adds tool definitions here. Imported by both `server.ts` (to register with
 * the MCP runtime) and `__tests__/wire.test.ts` (count + naming invariants).
 */
export const tools = [
  // tool definitions added by implementer
] as unknown as ToolDefinition<unknown, unknown, AppsScriptContext>[];
