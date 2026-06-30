import type { ToolDefinition } from "smart-mcp-core";
import type { TasksContext } from "../context.js";
import {
  listTaskListsTool,
  getTaskListTool,
  createTaskListTool,
  updateTaskListTool,
  deleteTaskListTool,
} from "./task-lists.js";
import {
  listTasksTool,
  getTaskTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  deleteTaskTool,
} from "./tasks.js";
import { moveTaskTool, clearCompletedTool } from "./tasks-move.js";
import {
  todayTasksTool,
  overdueTasksTool,
  quickAddTool,
} from "./shortcuts.js";

/**
 * Registry of every tasks-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (count + naming
 * invariants). Exactly 16 tools: 5 task-list + 6 task CRUD + move/clear +
 * 3 smart shortcuts.
 */
export const tools = [
  // Task lists (5)
  listTaskListsTool,
  getTaskListTool,
  createTaskListTool,
  updateTaskListTool,
  deleteTaskListTool,
  // Tasks (6)
  listTasksTool,
  getTaskTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  deleteTaskTool,
  // Organize (2)
  moveTaskTool,
  clearCompletedTool,
  // Smart shortcuts (3)
  todayTasksTool,
  overdueTasksTool,
  quickAddTool,
] as unknown as ToolDefinition<unknown, unknown, TasksContext>[];
