import type { ToolDefinition } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";

/**
 * Registry of every gdrive-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and the wire test (to assert count +
 * naming invariants). Empty in the scaffold — tools are added by the
 * implementers.
 */
export const tools = [] as unknown as ToolDefinition<
  unknown,
  unknown,
  GDriveContext
>[];
