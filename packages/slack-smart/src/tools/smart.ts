import { z } from "zod";
import {
  defineTool,
  resolveOne,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { mapChannel } from "../channel-mapper.js";
import { mapMessage, type SlimMessage } from "../message-mapper.js";
import { mapUser } from "../user-mapper.js";
import { asObject } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// catch_me_up
// ---------------------------------------------------------------------------

const catchMeUpInputSchema = z.object({
  // z.optional().default() — zod fills the default when field is absent or undefined
  since_hours: z.number().int().min(1).max(168).optional().default(24),
  dm_message_limit: z.number().int().min(1).max(20).optional().default(5),
  include_mentions: z.boolean().optional().default(true),
});

type CatchMeUpInput = z.infer<typeof catchMeUpInputSchema>;

type MentionMatch = {
  ts: string;
  text: string;
  channel_id?: string;
  channel_name?: string;
  permalink?: string;
};

type DmSummary = {
  channel_id: string;
  name?: string;
  latest: SlimMessage[];
  message_count: number;
};

type CatchMeUpOutput = {
  since_hours: number;
  dms: DmSummary[];
  mentions: MentionMatch[];
  notes: string[];
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export const catch_me_up = defineTool<CatchMeUpInput, CatchMeUpOutput, SlackContext>({
  name: "catch_me_up",
  description: "Summarize recent DM activity and @mentions since a given lookback window.",
  // Cast required: ZodDefault widens the input union type.
  inputSchema: catchMeUpInputSchema as unknown as z.ZodType<CatchMeUpInput>,
  handler: async (input, context) => {
    const notes: string[] = [];

    const me = await context.client.authTest("user");
    const cutoff = Math.floor(Date.now() / 1000) - input.since_hours * 3600;

    // Fetch IM/MPIM channels (DMs)
    const channelResp = await context.client.listChannels({
      types: "im,mpim",
      exclude_archived: true,
      limit: 100,
    });
    const dmChannels = channelResp.channels.map((c) =>
      mapChannel(c as Record<string, unknown>),
    );

    // For each DM, fetch recent history since cutoff
    const dmSummaries: DmSummary[] = [];
    await Promise.all(
      dmChannels.map(async (dm) => {
        const histResp = await context.client.getHistory({
          channel: dm.id,
          limit: input.dm_message_limit,
          oldest: String(cutoff),
        });
        const messages = histResp.messages.map(mapMessage);
        if (messages.length === 0) return;
        const entry: DmSummary = {
          channel_id: dm.id,
          latest: messages,
          message_count: messages.length,
        };
        if (dm.name !== null) entry.name = dm.name;
        dmSummaries.push(entry);
      }),
    );

    // Mentions
    const mentions: MentionMatch[] = [];
    if (input.include_mentions) {
      const searchResp = await context.client.searchMessages({
        query: "@" + me.user,
        count: 20,
        sort: "timestamp",
        sort_dir: "desc",
      });
      for (const raw of searchResp.messages.matches) {
        const obj = asObject(raw);
        const ts = asString(obj["ts"]) ?? "";
        const text = asString(obj["text"]) ?? "";
        const chanObj = asObject(obj["channel"]);
        const channel_id = asString(chanObj["id"]);
        const channel_name = asString(chanObj["name"]);
        const permalink = asString(obj["permalink"]);
        const match: MentionMatch = { ts, text };
        if (channel_id !== undefined) match.channel_id = channel_id;
        if (channel_name !== undefined) match.channel_name = channel_name;
        if (permalink !== undefined) match.permalink = permalink;
        mentions.push(match);
      }
      notes.push(
        "Mention detection uses search.messages which is approximate; very recent messages may be missing.",
      );
    }

    return {
      since_hours: input.since_hours,
      dms: dmSummaries,
      mentions,
      notes,
    };
  },
});

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

const mentionsInputSchema = z.object({
  // z.optional().default() — filled when absent
  count: z.number().int().min(1).max(100).optional().default(20),
  since_hours: z.number().int().min(1).max(168).optional(),
});

type MentionsInput = z.infer<typeof mentionsInputSchema>;

type MentionsOutput = {
  matches: MentionMatch[];
  count: number;
  notes: string[];
};

export const mentions = defineTool<MentionsInput, MentionsOutput, SlackContext>({
  name: "mentions",
  description: "Fetch recent @mentions of the authenticated user via search.",
  // Cast required: ZodDefault widens the input union type.
  inputSchema: mentionsInputSchema as unknown as z.ZodType<MentionsInput>,
  handler: async (input, context) => {
    const notes: string[] = [
      "Mention detection uses search.messages which is approximate; very recent messages may be missing.",
    ];

    const me = await context.client.authTest("user");

    const searchResp = await context.client.searchMessages({
      query: "@" + me.user,
      count: input.count,
      sort: "timestamp",
      sort_dir: "desc",
    });

    let rawMatches = searchResp.messages.matches;

    // Optional time filter when since_hours provided
    if (input.since_hours !== undefined) {
      const cutoff = Math.floor(Date.now() / 1000) - input.since_hours * 3600;
      rawMatches = rawMatches.filter((raw) => {
        const obj = asObject(raw);
        const ts = asString(obj["ts"]);
        if (ts === undefined) return false;
        return parseFloat(ts) >= cutoff;
      });
    }

    const matches: MentionMatch[] = rawMatches.map((raw) => {
      const obj = asObject(raw);
      const ts = asString(obj["ts"]) ?? "";
      const text = asString(obj["text"]) ?? "";
      const chanObj = asObject(obj["channel"]);
      const channel_id = asString(chanObj["id"]);
      const channel_name = asString(chanObj["name"]);
      const permalink = asString(obj["permalink"]);
      const match: MentionMatch = { ts, text };
      if (channel_id !== undefined) match.channel_id = channel_id;
      if (channel_name !== undefined) match.channel_name = channel_name;
      if (permalink !== undefined) match.permalink = permalink;
      return match;
    });

    return { matches, count: matches.length, notes };
  },
});

// ---------------------------------------------------------------------------
// unread_digest
// ---------------------------------------------------------------------------

const unreadDigestInputSchema = z.object({
  // z.optional().default() — filled when absent
  dm_message_limit: z.number().int().min(1).max(20).optional().default(3),
});

type UnreadDigestInput = z.infer<typeof unreadDigestInputSchema>;

type DmDigestEntry = {
  channel_id: string;
  name?: string;
  latest: SlimMessage[];
};

type UnreadDigestOutput = {
  dms: DmDigestEntry[];
  dm_count: number;
  notes: string[];
};

export const unread_digest = defineTool<UnreadDigestInput, UnreadDigestOutput, SlackContext>({
  name: "unread_digest",
  description: "Recent DM activity digest. Note: Slack API has no reliable per-DM unread count.",
  // Cast required: ZodDefault widens the input union type.
  inputSchema: unreadDigestInputSchema as unknown as z.ZodType<UnreadDigestInput>,
  handler: async (input, context) => {
    const notes: string[] = [
      "The Slack Web API does not expose a reliable per-DM unread count; this shows recent DM activity only.",
    ];

    const channelResp = await context.client.listChannels({
      types: "im,mpim",
      limit: 100,
    });
    const dmChannels = channelResp.channels.map((c) =>
      mapChannel(c as Record<string, unknown>),
    );

    const dms: DmDigestEntry[] = [];
    await Promise.all(
      dmChannels.map(async (dm) => {
        const histResp = await context.client.getHistory({
          channel: dm.id,
          limit: input.dm_message_limit,
        });
        const latest = histResp.messages.map(mapMessage);
        const entry: DmDigestEntry = { channel_id: dm.id, latest };
        if (dm.name !== null) entry.name = dm.name;
        dms.push(entry);
      }),
    );

    return { dms, dm_count: dms.length, notes };
  },
});

// ---------------------------------------------------------------------------
// thread_catchup
// ---------------------------------------------------------------------------

const threadCatchupInputSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  // z.optional().default() — filled when absent
  max: z.number().int().min(1).max(1000).optional().default(500),
});

type ThreadCatchupInput = z.infer<typeof threadCatchupInputSchema>;

type ThreadMessage = {
  author: string | null;
  text: string;
  ts: string;
};

type ThreadCatchupOutput = {
  messages: ThreadMessage[];
  count: number;
  truncated?: boolean;
};

export const thread_catchup = defineTool<ThreadCatchupInput, ThreadCatchupOutput, SlackContext>({
  name: "thread_catchup",
  description: "Fetch all replies in a thread, following pagination up to max messages.",
  // Cast required: ZodDefault widens the input union type.
  inputSchema: threadCatchupInputSchema as unknown as z.ZodType<ThreadCatchupInput>,
  handler: async (input, context) => {
    const allMessages: ThreadMessage[] = [];
    let cursor: string | undefined;
    let truncated = false;

    while (true) {
      const resp = await context.client.getReplies({
        channel: input.channel,
        ts: input.ts,
        limit: 200,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      for (const raw of resp.messages) {
        if (allMessages.length >= input.max) {
          truncated = true;
          break;
        }
        const obj = asObject(raw);
        const author = asString(obj["user"]) ?? null;
        const text = asString(obj["text"]) ?? "";
        const ts = asString(obj["ts"]) ?? "";
        allMessages.push({ author, text, ts });
      }

      if (truncated) break;

      const next = resp.response_metadata?.next_cursor;
      if (next === undefined || next === "") break;
      cursor = next;
    }

    const result: ThreadCatchupOutput = {
      messages: allMessages,
      count: allMessages.length,
    };
    if (truncated) result.truncated = true;
    return result;
  },
});

// ---------------------------------------------------------------------------
// smart_send
// ---------------------------------------------------------------------------

const smartSendInputSchema = z.object({
  channel_query: z.string().min(1).optional(),
  user_query: z.string().min(1).optional(),
  text: z.string().min(1),
  // z.optional().default() — filled when absent
  send_as: z.enum(["bot", "user"]).optional().default("bot"),
  confirm: z.boolean().optional().default(false),
});

type SmartSendInput = z.infer<typeof smartSendInputSchema>;

type SmartSendOutput = {
  ok: true;
  channel: string;
  ts: string;
  target: string;
};

export const smart_send = defineTool<SmartSendInput, SmartSendOutput, SlackContext>({
  name: "smart_send",
  description: "Fuzzy-resolve a channel or user then send a message (confirm-gated).",
  // Cast required: ZodDefault widens the input union type.
  inputSchema: smartSendInputSchema as unknown as z.ZodType<SmartSendInput>,
  handler: async (input, context) => {
    // Exactly one of channel_query/user_query required
    const hasChannel = input.channel_query !== undefined;
    const hasUser = input.user_query !== undefined;
    if (!hasChannel && !hasUser) {
      throw new ValidationError("Exactly one of channel_query or user_query is required.");
    }
    if (hasChannel && hasUser) {
      throw new ValidationError(
        "Provide channel_query or user_query, not both.",
      );
    }

    const identityLabel = input.send_as === "user" ? "you" : "the bot app";
    let targetId: string;
    let label: string;

    if (hasChannel) {
      const channelResp = await context.client.listChannels({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
      });
      const channels = channelResp.channels.map((c) =>
        mapChannel(c as Record<string, unknown>),
      );
      // resolveOne throws AmbiguousMatchError if no confident match — let it propagate
      const resolved = resolveOne(
        input.channel_query as string,
        channels,
        (c) => c.name ?? "",
        { threshold: 0.9 },
      );
      targetId = resolved.id;
      label = "#" + (resolved.name ?? resolved.id);
    } else {
      const usersResp = await context.client.listUsers({ limit: 200 });
      const users = usersResp.members.map(mapUser);
      // resolveOne throws AmbiguousMatchError if no confident match — let it propagate
      const resolved = resolveOne(
        input.user_query as string,
        users,
        (u) => u.display_name ?? u.real_name ?? u.name,
        { threshold: 0.9 },
      );
      const dmResp = await context.client.openDm({ users: resolved.id });
      targetId = dmResp.channel.id;
      label = "@" + (resolved.display_name ?? resolved.real_name ?? resolved.name);
    }

    const preview = `Send to ${label} as ${identityLabel}: "${input.text.slice(0, 80)}"`;
    guardDestructive({ confirm: input.confirm, preview });

    const result = await context.client.postMessage(
      { channel: targetId, text: input.text },
      input.send_as,
    );

    return { ok: true, channel: result.channel, ts: result.ts, target: label };
  },
});
