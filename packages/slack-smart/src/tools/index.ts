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

// identity (1)
// conversations (6)
export const tools: ToolDefinition<unknown, unknown, SlackContext>[] = [
  whoami as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  list_channels as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_history as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  thread_replies as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_info as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  channel_members as unknown as ToolDefinition<unknown, unknown, SlackContext>,
  open_dm as unknown as ToolDefinition<unknown, unknown, SlackContext>,
];
