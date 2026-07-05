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
  mark_read,
  get_message,
  join_channel,
  leave_channel,
  archive_channel,
  invite_to_channel,
  set_channel_purpose,
  set_channel_topic,
  create_channel,
} from "./conversations.js";
import {
  post_message,
  reply_in_thread,
  update_message,
  delete_message,
  schedule_message,
  get_permalink,
  list_scheduled,
  cancel_scheduled,
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
  set_status,
  set_presence,
} from "./users.js";
import {
  list_files,
  file_info,
  upload_file,
  read_file,
  delete_file,
} from "./files.js";
import {
  list_bookmarks,
  add_bookmark,
  edit_bookmark,
  remove_bookmark,
} from "./bookmarks.js";
import { list_pins, pin_message, unpin_message } from "./pins.js";
import { dnd_status, set_snooze, end_snooze } from "./dnd.js";
import { list_usergroups, team_info, list_emoji } from "./misc.js";
import {
  catch_me_up,
  mentions,
  unread_digest,
  thread_catchup,
  smart_send,
} from "./smart.js";
import { create_canvas, update_canvas } from "./canvas.js";

// identity (1)
// conversations (15)
// messages (8)
// search (2)
// reactions (3)
// users (8)
// files (5)
// bookmarks (4)
// pins (3)
// dnd (3)
// misc (3)
// smart (5)
// canvas (2)
export const tools: ToolDefinition<unknown, unknown, SlackContext>[] = [
  whoami as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_channels as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_history as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  thread_replies as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_members as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  open_dm as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  mark_read as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  get_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  join_channel as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  leave_channel as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  archive_channel as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  invite_to_channel as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  set_channel_purpose as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  set_channel_topic as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  create_channel as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  post_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  reply_in_thread as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  update_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  delete_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  schedule_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  get_permalink as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_scheduled as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  cancel_scheduled as unknown as ToolDefinition<unknown, unknown, SlackContext>,
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
  set_status as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  set_presence as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_files as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  file_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  upload_file as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  read_file as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  delete_file as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // bookmarks (4)
  list_bookmarks as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  add_bookmark as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  edit_bookmark as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  remove_bookmark as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // pins (3)
  list_pins as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  pin_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  unpin_message as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // dnd (3)
  dnd_status as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  set_snooze as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  end_snooze as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // misc (3)
  list_usergroups as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  team_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_emoji as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // smart (5)
  catch_me_up as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  mentions as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  unread_digest as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  thread_catchup as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  smart_send as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  // canvas (2)
  create_canvas as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  update_canvas as unknown as ToolDefinition<unknown, unknown, SlackContext>,
];
