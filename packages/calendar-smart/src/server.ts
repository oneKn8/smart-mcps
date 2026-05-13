#!/usr/bin/env node
import { createMcpServer, type ToolDefinition } from "smart-mcp-core";
import { buildContext, type CalendarContext } from "./context.js";
import { listEventsTool, getEventTool } from "./tools/events-read.js";
import {
  dailyAgendaTool,
  weeklyAgendaTool,
  nextEventTool,
} from "./tools/events-agenda.js";
import {
  listCalendarsTool,
  getCalendarTool,
} from "./tools/calendars.js";
import {
  findAvailabilityTool,
  busyBlocksTool,
  conflictsCheckTool,
} from "./tools/availability.js";

// Tool registry. Each tool definition is widened to the unknown-input/output
// shape that `createMcpServer` expects; the per-tool generic types are
// preserved at the source of truth (each tool's `defineTool<...>` call).
const tools: ToolDefinition<unknown, unknown, CalendarContext>[] = [
  listEventsTool as ToolDefinition<unknown, unknown, CalendarContext>,
  getEventTool as ToolDefinition<unknown, unknown, CalendarContext>,
  dailyAgendaTool as ToolDefinition<unknown, unknown, CalendarContext>,
  weeklyAgendaTool as ToolDefinition<unknown, unknown, CalendarContext>,
  nextEventTool as ToolDefinition<unknown, unknown, CalendarContext>,
  listCalendarsTool as ToolDefinition<unknown, unknown, CalendarContext>,
  getCalendarTool as ToolDefinition<unknown, unknown, CalendarContext>,
  findAvailabilityTool as ToolDefinition<unknown, unknown, CalendarContext>,
  busyBlocksTool as ToolDefinition<unknown, unknown, CalendarContext>,
  conflictsCheckTool as ToolDefinition<unknown, unknown, CalendarContext>,
];

await createMcpServer<CalendarContext>({
  name: "calendar-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
