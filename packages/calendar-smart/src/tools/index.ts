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
import {
  createCalendarTool,
  updateCalendarTool,
  deleteCalendarTool,
  clearPrimaryCalendarTool,
} from "./calendars-write.js";
import {
  subscribeCalendarTool,
  unsubscribeCalendarTool,
  updateCalendarSubscriptionTool,
} from "./calendar-subscriptions.js";
import {
  listCalendarSharesTool,
  shareCalendarTool,
  updateCalendarShareTool,
  revokeCalendarShareTool,
} from "./acl.js";
import {
  listUserSettingsTool,
  getUserSettingTool,
} from "./settings.js";
import { getColorsTool } from "./colors.js";
import { moveEventTool } from "./events-move.js";
import { freebusyGroupTool } from "./freebusy-group.js";
import { getCalendarMetadataTool } from "./calendar-metadata.js";

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
  // Wave 3: calendar resource CRUD (4)
  createCalendarTool,
  updateCalendarTool,
  deleteCalendarTool,
  clearPrimaryCalendarTool,
  // Wave 3: CalendarList subscription management (3)
  subscribeCalendarTool,
  unsubscribeCalendarTool,
  updateCalendarSubscriptionTool,
  // Wave 4: ACL (sharing) (4)
  listCalendarSharesTool,
  shareCalendarTool,
  updateCalendarShareTool,
  revokeCalendarShareTool,
  // Wave 4: settings (2) + colors (1)
  listUserSettingsTool,
  getUserSettingTool,
  getColorsTool,
  // Wave 4: event-level move (1) + group freebusy (1) + bare metadata (1)
  moveEventTool,
  freebusyGroupTool,
  getCalendarMetadataTool,
] as unknown as ToolDefinition<unknown, unknown, CalendarContext>[];
