import type { ToolDefinition } from "smart-mcp-core";
import type { FlowContext } from "../context.js";
import { emailToTaskTool } from "./email-to-task.js";
import { taskToCalendarBlockTool } from "./task-to-calendar-block.js";
import { weeklyReviewDocTool } from "./weekly-review-doc.js";
import { inboxDigestDocTool } from "./inbox-digest-doc.js";
import { dailyBriefDocTool } from "./daily-brief-doc.js";
import { deployInboxWatcherTool } from "./deploy-inbox-watcher.js";

/**
 * Registry of every flow-smart tool. Each is thin glue over the sibling
 * clients (tasks / docs / apps-script / calendar / email) imported through
 * their `./client` subpaths — flow-smart owns no API, HTTP, or storage code.
 * Imported by both `server.ts` (to register with the MCP runtime) and
 * `__tests__/wire.test.ts` (count + naming invariants).
 */
export const tools = [
  emailToTaskTool,
  taskToCalendarBlockTool,
  weeklyReviewDocTool,
  inboxDigestDocTool,
  dailyBriefDocTool,
  deployInboxWatcherTool,
] as unknown as ToolDefinition<unknown, unknown, FlowContext>[];
