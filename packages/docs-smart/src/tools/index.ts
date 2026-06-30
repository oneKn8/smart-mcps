import type { ToolDefinition } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import {
  getDocumentTool,
  readTextTool,
  createDocumentTool,
} from "./documents.js";
import {
  insertTextTool,
  appendTextTool,
  deleteRangeTool,
  replaceAllTextTool,
} from "./edit-text.js";
import {
  setTextStyleTool,
  setParagraphStyleTool,
  setHeadingTool,
  makeBulletsTool,
  removeBulletsTool,
} from "./styles.js";
import { insertTableTool, fillTableTool } from "./tables.js";
import { insertImageTool, insertPageBreakTool } from "./media.js";
import { createDocFromMarkdownTool } from "./markdown-tool.js";
import { batchUpdateTool } from "./raw.js";

/**
 * Registry of every docs-smart tool. Imported by both `server.ts` (to register
 * with the MCP runtime) and `__tests__/wire.test.ts` (count + naming
 * invariants). Order is documentation: read/create, then text edits, then
 * styling, then tables, then media, then the markdown flagship + raw escape.
 */
export const tools = [
  // Read / create (3)
  getDocumentTool,
  readTextTool,
  createDocumentTool,
  // Text edits (4)
  insertTextTool,
  deleteRangeTool,
  replaceAllTextTool,
  appendTextTool,
  // Styling (5)
  setTextStyleTool,
  setParagraphStyleTool,
  setHeadingTool,
  makeBulletsTool,
  removeBulletsTool,
  // Tables (2)
  insertTableTool,
  fillTableTool,
  // Media (2)
  insertImageTool,
  insertPageBreakTool,
  // Markdown flagship (1) + raw escape hatch (1)
  createDocFromMarkdownTool,
  batchUpdateTool,
] as unknown as ToolDefinition<unknown, unknown, DocsContext>[];
