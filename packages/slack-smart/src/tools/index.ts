import type { ToolDefinition } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { whoami } from "./identity.js";
import {
  list_channels,
  channel_history,
  thread_replies,
  channel_info,
  channel_members,
  open_dm,
} from "./conversations.js";
import {
  post_message,
  reply_in_thread,
  update_message,
  delete_message,
  schedule_message,
} from "./messages.js";
import { search_messages, search_files } from "./search.js";
import { add_reaction, remove_reaction, get_reactions } from "./reactions.js";
import {
  list_users,
  user_info,
  user_profile,
  lookup_by_email,
  user_presence,
  resolve_user,
} from "./users.js";

// identity (1)
// conversations (6)
// messages (5)
// search (2)
// reactions (3)
// users (6)
export const tools: ToolDefinition<unknown, unknown, SlackContext>[] = [
  whoami as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_channels as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_history as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  thread_replies as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_members as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  open_dm as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  post_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  reply_in_thread as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  update_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  delete_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  schedule_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  search_messages as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  search_files as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  add_reaction as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  remove_reaction as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  get_reactions as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_users as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  user_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  user_profile as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  lookup_by_email as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  user_presence as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  resolve_user as unknown as ToolDefinition<unknown, unknown, SlackContext>,
];
