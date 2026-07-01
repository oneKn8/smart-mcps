import type { ToolDefinition } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import {
  createFolderTool,
  createShortcutTool,
  generateIdsTool,
} from "./files-create.js";
import {
  renameTool,
  moveTool,
  starTool,
  updateMetadataTool,
  copyTool,
} from "./files-organize.js";
import {
  trashTool,
  restoreTool,
  deleteTool,
  emptyTrashTool,
} from "./files-lifecycle.js";
import { getTool, listTool } from "./files-read.js";
import {
  shareTool,
  listPermissionsTool,
  updatePermissionTool,
  unshareTool,
} from "./permissions.js";
import {
  uploadTool,
  updateContentTool,
  downloadTool,
  exportFileTool,
} from "./media.js";

/**
 * Registry of every gdrive-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (to assert
 * count + naming invariants without parsing server.ts).
 *
 * 22 tools total: 18 from the JSON half (organize / lifecycle / read /
 * sharing) plus 4 from the media half (upload / update_content / download /
 * export_file).
 */
export const tools = [
  // Create / organize (3)
  createFolderTool,
  createShortcutTool,
  generateIdsTool,
  // Organize (5)
  renameTool,
  moveTool,
  starTool,
  updateMetadataTool,
  copyTool,
  // Lifecycle (4)
  trashTool,
  restoreTool,
  deleteTool,
  emptyTrashTool,
  // Read (2)
  getTool,
  listTool,
  // Sharing (4)
  shareTool,
  listPermissionsTool,
  updatePermissionTool,
  unshareTool,
  // Media (4)
  uploadTool,
  updateContentTool,
  downloadTool,
  exportFileTool,
] as unknown as ToolDefinition<unknown, unknown, GDriveContext>[];
