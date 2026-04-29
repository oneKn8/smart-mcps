import type { ToolDefinition } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { sendEmail } from "./send.js";
import { sendWithTemplate } from "./send-template.js";
import { listIdentitiesTool, getIdentityTool } from "./identities.js";
import { listRecentSendsTool, searchAuditTool } from "./audit.js";
import {
  listInbox,
  searchEmails,
  readEmail,
  getThread,
  bulkReadMessages,
} from "./inbox.js";
import {
  markReadByQuery,
  archiveByQuery,
  trashByQuery,
  applyLabelByQuery,
} from "./modify.js";

export const tools: ToolDefinition<unknown, unknown, EmailContext>[] = [
  sendEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  sendWithTemplate as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listIdentitiesTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  getIdentityTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listRecentSendsTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  searchAuditTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listInbox as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  searchEmails as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  readEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  getThread as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  bulkReadMessages as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  markReadByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  archiveByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  trashByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  applyLabelByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
];
