import type { ToolDefinition } from "smart-mcp-core";
import type { SheetsContext } from "../context.js";
import {
  listSheetsTool,
  createSheetTool,
  getSheetTool,
  deleteSheetTool,
} from "./spreadsheets.js";
import {
  readRangeTool,
  writeRangeTool,
  appendRowsTool,
  updateCellsTool,
  clearRangeTool,
} from "./values.js";
import {
  addTabTool,
  renameTabTool,
  deleteTabTool,
  formatRangeTool,
  batchUpdateTool,
} from "./structure.js";
import { shareSheetTool, quickAddRowTool } from "./sharing.js";

/**
 * Registry of every sheets-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (to assert
 * count + naming invariants without parsing server.ts).
 *
 * Order is documentation: discovery/lifecycle first, then value read/write,
 * then structure/format, then the raw escape hatch and shortcuts.
 */
export const tools = [
  // Discover / lifecycle (4)
  listSheetsTool,
  createSheetTool,
  getSheetTool,
  deleteSheetTool,
  // Values (5)
  readRangeTool,
  writeRangeTool,
  appendRowsTool,
  updateCellsTool,
  clearRangeTool,
  // Structure / format (4) + raw escape hatch (1)
  addTabTool,
  renameTabTool,
  deleteTabTool,
  formatRangeTool,
  batchUpdateTool,
  // Sharing (1) + shortcut (1)
  shareSheetTool,
  quickAddRowTool,
] as unknown as ToolDefinition<unknown, unknown, SheetsContext>[];
