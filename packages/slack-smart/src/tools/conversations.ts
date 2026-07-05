import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { mapChannel, type SlimChannel } from "../channel-mapper.js";
import { mapMessage, type SlimMessage } from "../message-mapper.js";

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

const listChannelsInputSchema = z.object({
  types: z.string().optional().default("public_channel"),
  exclude_archived: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(999).optional().default(100),
  cursor: z.string().optional(),
});

type ListChannelsInput = z.infer<typeof listChannelsInputSchema>;

type ListChannelsOutput = {
  channels: SlimChannel[];
  count: number;
  next_cursor?: string;
};

export const list_channels = defineTool<
  ListChannelsInput,
  ListChannelsOutput,
  SlackContext
>({
  name: "list_channels",
  description: "List channels the token can access.",
  // Cast required: ZodDefault makes input type optional but output type required.
  inputSchema: listChannelsInputSchema as unknown as z.ZodType<ListChannelsInput>,
  handler: async (input, context) => {
    const resp = await context.client.listChannels({
      types: input.types,
      exclude_archived: input.exclude_archived,
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const channels = resp.channels.map((c) =>
      mapChannel(c as Record<string, unknown>),
    );
    const next = resp.response_metadata?.next_cursor;
    return {
      channels,
      count: channels.length,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// channel_history
// ---------------------------------------------------------------------------

const channelHistoryInputSchema = z.object({
  channel: z.string(),
  limit: z.number().int().min(1).max(999).optional().default(50),
  oldest: z.string().optional(),
  latest: z.string().optional(),
  inclusive: z.boolean().optional(),
  cursor: z.string().optional(),
});

type ChannelHistoryInput = z.infer<typeof channelHistoryInputSchema>;

type ChannelHistoryOutput = {
  messages: SlimMessage[];
  count: number;
  has_more?: boolean;
  next_cursor?: string;
};

export const channel_history = defineTool<
  ChannelHistoryInput,
  ChannelHistoryOutput,
  SlackContext
>({
  name: "channel_history",
  description: "Fetch messages from a channel.",
  // Cast required: ZodDefault makes limit's input type optional but output required.
  inputSchema: channelHistoryInputSchema as unknown as z.ZodType<ChannelHistoryInput>,
  handler: async (input, context) => {
    const resp = await context.client.getHistory({
      channel: input.channel,
      limit: input.limit,
      ...(input.oldest !== undefined ? { oldest: input.oldest } : {}),
      ...(input.latest !== undefined ? { latest: input.latest } : {}),
      ...(input.inclusive !== undefined ? { inclusive: input.inclusive } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const messages = resp.messages.map((m) => mapMessage(m));
    const next = resp.response_metadata?.next_cursor;
    return {
      messages,
      count: messages.length,
      ...(resp.has_more !== undefined ? { has_more: resp.has_more } : {}),
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// thread_replies
// ---------------------------------------------------------------------------

const threadRepliesInputSchema = z.object({
  channel: z.string(),
  ts: z.string(),
  limit: z.number().int().min(1).max(999).optional(),
  cursor: z.string().optional(),
});

type ThreadRepliesInput = z.infer<typeof threadRepliesInputSchema>;

type ThreadRepliesOutput = {
  messages: SlimMessage[];
  count: number;
  next_cursor?: string;
};

export const thread_replies = defineTool<
  ThreadRepliesInput,
  ThreadRepliesOutput,
  SlackContext
>({
  name: "thread_replies",
  description: "Fetch replies in a thread (first message is the parent).",
  inputSchema: threadRepliesInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getReplies({
      channel: input.channel,
      ts: input.ts,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const messages = resp.messages.map((m) => mapMessage(m));
    const next = resp.response_metadata?.next_cursor;
    return {
      messages,
      count: messages.length,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// channel_info
// ---------------------------------------------------------------------------

const channelInfoInputSchema = z.object({
  channel: z.string(),
});

type ChannelInfoInput = z.infer<typeof channelInfoInputSchema>;

export const channel_info = defineTool<ChannelInfoInput, SlimChannel, SlackContext>({
  name: "channel_info",
  description: "Get metadata for a single channel.",
  inputSchema: channelInfoInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getChannelInfo({
      channel: input.channel,
      include_num_members: true,
    });
    return mapChannel(resp.channel as Record<string, unknown>);
  },
});

// ---------------------------------------------------------------------------
// channel_members
// ---------------------------------------------------------------------------

const channelMembersInputSchema = z.object({
  channel: z.string(),
  limit: z.number().int().min(1).max(999).optional(),
  cursor: z.string().optional(),
});

type ChannelMembersInput = z.infer<typeof channelMembersInputSchema>;

type ChannelMembersOutput = {
  members: string[];
  count: number;
  next_cursor?: string;
};

export const channel_members = defineTool<
  ChannelMembersInput,
  ChannelMembersOutput,
  SlackContext
>({
  name: "channel_members",
  description: "List user IDs in a channel.",
  inputSchema: channelMembersInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getMembers({
      channel: input.channel,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const members = resp.members.filter(
      (m): m is string => typeof m === "string",
    );
    const next = resp.response_metadata?.next_cursor;
    return {
      members,
      count: members.length,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// open_dm
// ---------------------------------------------------------------------------

const openDmInputSchema = z.object({
  users: z.string(),
});

type OpenDmInput = z.infer<typeof openDmInputSchema>;

type OpenDmOutput = { channel_id: string };

export const open_dm = defineTool<OpenDmInput, OpenDmOutput, SlackContext>({
  name: "open_dm",
  description: "Open (or retrieve) a DM channel with given user IDs.",
  inputSchema: openDmInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.openDm({ users: input.users });
    return { channel_id: resp.channel.id };
  },
});

// ---------------------------------------------------------------------------
// mark_read
// ---------------------------------------------------------------------------

const markReadInputSchema = z.object({
  channel: z.string().min(1),
  // Mark read up to this message ts. Omit to mark read up to the latest message.
  ts: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type MarkReadInput = z.infer<typeof markReadInputSchema>;

type MarkReadOutput = { ok: true; channel: string; ts: string };

export const mark_read = defineTool<MarkReadInput, MarkReadOutput, SlackContext>({
  name: "mark_read",
  description: "Mark a channel or DM read up to a message (write — confirm-gated).",
  // Cast required: ZodDefault on confirm widens the schema input type.
  inputSchema: markReadInputSchema as unknown as z.ZodType<MarkReadInput>,
  handler: async (input, context) => {
    let ts = input.ts;
    if (ts === undefined) {
      // Resolve the latest message ts so "mark this DM read" needs no ts.
      const resp = await context.client.getHistory({
        channel: input.channel,
        limit: 1,
      });
      const latest = resp.messages[0];
      const resolved = latest !== undefined ? mapMessage(latest).ts : "";
      if (resolved === "") {
        throw new ValidationError(
          `mark_read: ${input.channel} has no messages to mark read.`,
        );
      }
      ts = resolved;
    }
    guardDestructive({
      confirm: input.confirm,
      preview: `Mark ${input.channel} read up to ${ts}`,
    });
    await context.client.markConversation({ channel: input.channel, ts });
    return { ok: true, channel: input.channel, ts };
  },
});

// ---------------------------------------------------------------------------
// invite_to_channel
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens the schema input type.
const inviteToChannelInputSchema = z.object({
  channel: z.string().min(1),
  users: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type InviteToChannelInput = z.infer<typeof inviteToChannelInputSchema>;

export const invite_to_channel = defineTool<
  InviteToChannelInput,
  SlimChannel,
  SlackContext
>({
  name: "invite_to_channel",
  description:
    "Invite users (comma-separated IDs) to a channel (user token, scopes channels:write.invites/groups:write.invites).",
  inputSchema: inviteToChannelInputSchema as unknown as z.ZodType<InviteToChannelInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Invite ${input.users} to ${input.channel}`,
    });
    const resp = await context.client.inviteToChannel({
      channel: input.channel,
      users: input.users,
    });
    return mapChannel(resp.channel as Record<string, unknown>);
  },
});

// ---------------------------------------------------------------------------
// set_channel_purpose
// ---------------------------------------------------------------------------

const setChannelPurposeInputSchema = z.object({
  channel: z.string().min(1),
  purpose: z.string(),
  confirm: z.boolean().optional().default(false),
});

type SetChannelPurposeInput = z.infer<typeof setChannelPurposeInputSchema>;

type SetChannelPurposeOutput = { ok: true; purpose: string };

export const set_channel_purpose = defineTool<
  SetChannelPurposeInput,
  SetChannelPurposeOutput,
  SlackContext
>({
  name: "set_channel_purpose",
  description:
    "Set a channel's purpose/description (user token, scope channels:write/groups:write).",
  inputSchema: setChannelPurposeInputSchema as unknown as z.ZodType<SetChannelPurposeInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Set purpose of ${input.channel}`,
    });
    await context.client.setChannelPurpose({
      channel: input.channel,
      purpose: input.purpose,
    });
    return { ok: true, purpose: input.purpose };
  },
});

// ---------------------------------------------------------------------------
// set_channel_topic
// ---------------------------------------------------------------------------

const setChannelTopicInputSchema = z.object({
  channel: z.string().min(1),
  topic: z.string(),
  confirm: z.boolean().optional().default(false),
});

type SetChannelTopicInput = z.infer<typeof setChannelTopicInputSchema>;

type SetChannelTopicOutput = { ok: true; topic: string };

export const set_channel_topic = defineTool<
  SetChannelTopicInput,
  SetChannelTopicOutput,
  SlackContext
>({
  name: "set_channel_topic",
  description: "Set a channel's topic (user token, scope channels:write/groups:write).",
  inputSchema: setChannelTopicInputSchema as unknown as z.ZodType<SetChannelTopicInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Set topic of ${input.channel}`,
    });
    await context.client.setChannelTopic({
      channel: input.channel,
      topic: input.topic,
    });
    return { ok: true, topic: input.topic };
  },
});

// ---------------------------------------------------------------------------
// create_channel
// ---------------------------------------------------------------------------

const createChannelInputSchema = z.object({
  name: z.string().min(1),
  is_private: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type CreateChannelInput = z.infer<typeof createChannelInputSchema>;

export const create_channel = defineTool<
  CreateChannelInput,
  SlimChannel,
  SlackContext
>({
  name: "create_channel",
  description: "Create a public or private channel (user token, scope channels:write/groups:write).",
  inputSchema: createChannelInputSchema as unknown as z.ZodType<CreateChannelInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Create ${input.is_private ? "private" : "public"} channel #${input.name}`,
    });
    const resp = await context.client.createConversation({
      name: input.name,
      is_private: input.is_private,
    });
    return mapChannel(resp.channel as Record<string, unknown>);
  },
});

// ---------------------------------------------------------------------------
// get_message (read-only)
// ---------------------------------------------------------------------------

const getMessageInputSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
});

type GetMessageInput = z.infer<typeof getMessageInputSchema>;

export const get_message = defineTool<GetMessageInput, SlimMessage, SlackContext>({
  name: "get_message",
  description: "Get a single message by channel and timestamp.",
  inputSchema: getMessageInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getHistory({
      channel: input.channel,
      latest: input.ts,
      oldest: input.ts,
      inclusive: true,
      limit: 1,
    });
    const first = resp.messages[0];
    if (first === undefined) {
      throw new ValidationError(
        `get_message: no message at ts ${input.ts} in ${input.channel}`,
      );
    }
    return mapMessage(first);
  },
});

// ---------------------------------------------------------------------------
// join_channel
// ---------------------------------------------------------------------------

const joinChannelInputSchema = z.object({ channel: z.string().min(1) });

type JoinChannelInput = z.infer<typeof joinChannelInputSchema>;

export const join_channel = defineTool<JoinChannelInput, SlimChannel, SlackContext>({
  name: "join_channel",
  description: "Join a public channel by ID.",
  inputSchema: joinChannelInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.joinChannel({ channel: input.channel });
    return mapChannel(resp.channel as Record<string, unknown>);
  },
});

// ---------------------------------------------------------------------------
// leave_channel
// ---------------------------------------------------------------------------

const leaveChannelInputSchema = z.object({
  channel: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type LeaveChannelInput = z.infer<typeof leaveChannelInputSchema>;

export const leave_channel = defineTool<
  LeaveChannelInput,
  { ok: true; channel: string },
  SlackContext
>({
  name: "leave_channel",
  description: "Leave a channel by ID (write — confirm-gated).",
  // Cast required: ZodDefault on confirm widens schema input type.
  inputSchema: leaveChannelInputSchema as unknown as z.ZodType<LeaveChannelInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Leave ${input.channel}`,
    });
    await context.client.leaveChannel({ channel: input.channel });
    return { ok: true, channel: input.channel };
  },
});

// ---------------------------------------------------------------------------
// archive_channel
// ---------------------------------------------------------------------------

const archiveChannelInputSchema = z.object({
  channel: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type ArchiveChannelInput = z.infer<typeof archiveChannelInputSchema>;

export const archive_channel = defineTool<
  ArchiveChannelInput,
  { ok: true; channel: string },
  SlackContext
>({
  name: "archive_channel",
  description: "Archive a channel by ID (write — confirm-gated).",
  // Cast required: ZodDefault on confirm widens schema input type.
  inputSchema: archiveChannelInputSchema as unknown as z.ZodType<ArchiveChannelInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Archive ${input.channel} (hides it for everyone)`,
    });
    await context.client.archiveChannel({ channel: input.channel });
    return { ok: true, channel: input.channel };
  },
});
