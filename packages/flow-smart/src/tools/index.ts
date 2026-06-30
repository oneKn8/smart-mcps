import type { ToolDefinition } from "smart-mcp-core";
import type { FlowContext } from "../context.js";

/**
 * Registry of every flow-smart tool. Empty for now — the implementer adds
 * the cross-app orchestration tools here. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (count +
 * naming invariants).
 */
export const tools = [
  // tool definitions added by implementer
] as unknown as ToolDefinition<unknown, unknown, FlowContext>[];
