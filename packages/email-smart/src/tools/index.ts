import type { ToolDefinition } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { sendEmail } from "./send.js";
import { sendWithTemplate } from "./send-template.js";
import { sendWithAttachment } from "./send-attachment.js";
import { composeThread } from "./compose-thread.js";
import { bulkSend } from "./bulk-send.js";
import { bulkUnsubscribe } from "./bulk-unsubscribe.js";
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
import {
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
} from "./labels.js";
import { dailyStatus, inboxZeroDryRun } from "./smart.js";
import {
  createDraft,
  listDrafts,
  sendDraft,
  updateDraft,
  deleteDraft,
} from "./drafts.js";
import { createFilter, listFilters, deleteFilter } from "./filters.js";
import { getVacation, updateVacation } from "./vacation.js";
import {
  getImap,
  updateImap,
  getPop,
  updatePop,
  updateLanguage,
} from "./mail-client-settings.js";
import { listSendAs, updateSendAs } from "./send-as.js";

export const tools: ToolDefinition<unknown, unknown, EmailContext>[] = [
  // Send (5)
  sendEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  sendWithTemplate as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  sendWithAttachment as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  composeThread as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  bulkSend as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Identities + audit (4)
  listIdentitiesTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  getIdentityTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listRecentSendsTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  searchAuditTool as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Inbox read (5)
  listInbox as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  searchEmails as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  readEmail as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  getThread as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  bulkReadMessages as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Bulk modify (4) — destructive with dry_run + confirm
  markReadByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  archiveByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  trashByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  applyLabelByQuery as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Labels (4) — list + CRUD
  listLabels as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  createLabel as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateLabel as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  deleteLabel as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Smart shortcuts (2)
  dailyStatus as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  inboxZeroDryRun as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Bulk unsubscribe (1) — destructive
  bulkUnsubscribe as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Drafts CRUD (5)
  createDraft as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listDrafts as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  sendDraft as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateDraft as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  deleteDraft as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Filters (3) — gmail.settings.basic; create_filter resolves label names
  createFilter as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  listFilters as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  deleteFilter as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Vacation (2) — gmail.settings.basic
  getVacation as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateVacation as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // IMAP / POP / language (5) — gmail.settings.basic
  getImap as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateImap as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  getPop as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updatePop as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateLanguage as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  // Send-as (2) — gmail.settings.basic (signature / display name updates)
  listSendAs as unknown as ToolDefinition<unknown, unknown, EmailContext>,
  updateSendAs as unknown as ToolDefinition<unknown, unknown, EmailContext>,
];
