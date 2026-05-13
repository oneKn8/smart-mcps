#!/usr/bin/env node
import { createMcpServer, type ToolDefinition } from "smart-mcp-core";
import { buildContext, type CalendarContext } from "./context.js";

// Empty for now — populated in Phase 5 tasks 4-11.
const tools: ToolDefinition<unknown, unknown, CalendarContext>[] = [];

await createMcpServer<CalendarContext>({
  name: "calendar-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
