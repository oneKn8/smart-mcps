import type { ToolDefinition } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { listEventsTool, getEventTool } from "./events-read.js";
import {
  dailyAgendaTool,
  weeklyAgendaTool,
  nextEventTool,
} from "./events-agenda.js";
import { listCalendarsTool, getCalendarTool } from "./calendars.js";
import {
  findAvailabilityTool,
  busyBlocksTool,
  conflictsCheckTool,
} from "./availability.js";
import {
  quickAddTool,
  createEventTool,
  respondToEventTool,
} from "./events-create.js";
import {
  updateEventTool,
  rescheduleTool,
  cancelEventTool,
} from "./events-update.js";
import {
  dailyBriefTool,
  weeklyBriefTool,
  findMeetingTimeTool,
  eventWithInvitePreviewTool,
  outdoorEventCheckTool,
} from "./shortcuts.js";
import {
  listInstancesTool,
  updateInstanceTool,
  cancelInstanceTool,
  splitRecurrenceTool,
} from "./events-recurring.js";
import { searchEventsTool } from "./events-search.js";
import { syncEventsTool } from "./events-sync.js";

/**
 * Registry of every calendar-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (to assert
 * count + naming invariants without parsing server.ts).
 *
 * Order is documentation: read primitives first, then availability, then
 * create/modify, then calendar management, then composition shortcuts.
 */
export const tools = [
  // Read (5)
  listEventsTool,
  getEventTool,
  dailyAgendaTool,
  weeklyAgendaTool,
  nextEventTool,
  // Availability (3)
  findAvailabilityTool,
  busyBlocksTool,
  conflictsCheckTool,
  // Create / modify (6)
  quickAddTool,
  createEventTool,
  updateEventTool,
  rescheduleTool,
  cancelEventTool,
  respondToEventTool,
  // Calendar management (2)
  listCalendarsTool,
  getCalendarTool,
  // Smart shortcuts (5)
  dailyBriefTool,
  weeklyBriefTool,
  findMeetingTimeTool,
  eventWithInvitePreviewTool,
  outdoorEventCheckTool,
  // Wave 2: recurring expansion + occurrence ops (4)
  listInstancesTool,
  updateInstanceTool,
  cancelInstanceTool,
  splitRecurrenceTool,
  // Wave 2: search (1)
  searchEventsTool,
  // Wave 2: incremental sync (1)
  syncEventsTool,
] as unknown as ToolDefinition<unknown, unknown, CalendarContext>[];
