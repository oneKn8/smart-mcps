import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { SlackContext } from "../context.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function identityLabel(sendAs: "bot" | "user"): string {
  return sendAs === "bot" ? "the bot app" : "you";
}

// ---------------------------------------------------------------------------
// post_message
// ---------------------------------------------------------------------------

const postMessageInputSchema = z.object({
  channel: z.string().min(1),
  text: z.string().optional(),
  blocks_json: z.string().optional(),
  thread_ts: z.string().optional(),
  reply_broadcast: z.boolean().optional(),
  unfurl_links: z.boolean().optional(),
  // "bot" posts as the installed app (requires SLACK_BOT_TOKEN).
  // "user" posts as the authenticated user (uses SLACK_USER_TOKEN).
  // Slack's deprecated `as_user` param is NOT forwarded — token selection alone
  // controls posting identity on modern Slack apps.
  // Default "user": the bot app is often not installed in the target workspace,
  // so posting as the authenticated user is the safe default.
  send_as: z.enum(["bot", "user"]).optional().default("user"),
  confirm: z.boolean().optional().default(false),
});

type PostMessageInput = z.infer<typeof postMessageInputSchema>;

type PostMessageOutput = { ok: true; channel: string; ts: string };

export const post_message = defineTool<
  PostMessageInput,
  PostMessageOutput,
  SlackContext
>({
  name: "post_message",
  description: "Post a message to a channel or DM.",
  // Cast required: ZodDefault on send_as/confirm widens schema input type vs
  // the resolved type the handler receives.
  inputSchema: postMessageInputSchema as unknown as z.ZodType<PostMessageInput>,
  handler: async (input, context) => {
    if (input.text === undefined && input.blocks_json === undefined) {
      throw new ValidationError(
        "post_message requires at least one of text or blocks_json",
      );
    }

    let blocks: unknown[] | undefined;
    if (input.blocks_json !== undefined) {
      try {
        const parsed: unknown = JSON.parse(input.blocks_json);
        if (!Array.isArray(parsed)) {
          throw new ValidationError(
            "blocks_json must be a JSON array of Slack Block Kit block objects",
          );
        }
        blocks = parsed;
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          `blocks_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const previewText =
      input.text !== undefined
        ? truncate(input.text)
        : "[blocks only — no text]";

    guardDestructive({
      confirm: input.confirm,
      preview: `Post to ${input.channel} as ${identityLabel(input.send_as)}: "${previewText}"`,
    });

    const args: Record<string, string | number | boolean | undefined> = {
      channel: input.channel,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.thread_ts !== undefined ? { thread_ts: input.thread_ts } : {}),
      ...(input.reply_broadcast !== undefined
        ? { reply_broadcast: input.reply_broadcast }
        : {}),
      ...(input.unfurl_links !== undefined
        ? { unfurl_links: input.unfurl_links }
        : {}),
    };

    if (blocks !== undefined) {
      // slackCall accepts Record<string, string|number|boolean|undefined> for
      // args, but blocks is an array. Cast via JSON serialisation to avoid
      // fighting the generic constraint — slackCall's POST path accepts the
      // full JSON body and fetchJson will serialise it correctly.
      (args as Record<string, unknown>)["blocks"] = blocks;
    }

    const resp = await context.client.postMessage(args, input.send_as);
    return { ok: true, channel: resp.channel, ts: resp.ts };
  },
});

// ---------------------------------------------------------------------------
// reply_in_thread
// ---------------------------------------------------------------------------

const replyInThreadInputSchema = z.object({
  channel: z.string().min(1),
  thread_ts: z.string().min(1),
  text: z.string().min(1),
  reply_broadcast: z.boolean().optional(),
  send_as: z.enum(["bot", "user"]).optional().default("user"),
  confirm: z.boolean().optional().default(false),
});

type ReplyInThreadInput = z.infer<typeof replyInThreadInputSchema>;

type ReplyInThreadOutput = { ok: true; channel: string; ts: string };

export const reply_in_thread = defineTool<
  ReplyInThreadInput,
  ReplyInThreadOutput,
  SlackContext
>({
  name: "reply_in_thread",
  description: "Reply to a thread in a channel.",
  // Cast required: ZodDefault on send_as/confirm widens schema input type.
  inputSchema: replyInThreadInputSchema as unknown as z.ZodType<ReplyInThreadInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Reply in thread ${input.thread_ts} in ${input.channel} as ${identityLabel(input.send_as)}: "${truncate(input.text)}"`,
    });

    const args: Record<string, string | number | boolean | undefined> = {
      channel: input.channel,
      text: input.text,
      thread_ts: input.thread_ts,
      ...(input.reply_broadcast !== undefined
        ? { reply_broadcast: input.reply_broadcast }
        : {}),
    };

    const resp = await context.client.postMessage(args, input.send_as);
    return { ok: true, channel: resp.channel, ts: resp.ts };
  },
});

// ---------------------------------------------------------------------------
// update_message
// ---------------------------------------------------------------------------

const updateMessageInputSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  text: z.string().optional(),
  blocks_json: z.string().optional(),
  send_as: z.enum(["bot", "user"]).optional().default("user"),
  confirm: z.boolean().optional().default(false),
});

type UpdateMessageInput = z.infer<typeof updateMessageInputSchema>;

type UpdateMessageOutput = { ok: true; channel: string; ts: string };

export const update_message = defineTool<
  UpdateMessageInput,
  UpdateMessageOutput,
  SlackContext
>({
  name: "update_message",
  description: "Edit the text of an existing message.",
  // Cast required: ZodDefault on send_as/confirm widens schema input type.
  inputSchema: updateMessageInputSchema as unknown as z.ZodType<UpdateMessageInput>,
  handler: async (input, context) => {
    if (input.text === undefined && input.blocks_json === undefined) {
      throw new ValidationError(
        "update_message requires at least one of text or blocks_json",
      );
    }

    let blocks: unknown[] | undefined;
    if (input.blocks_json !== undefined) {
      try {
        const parsed: unknown = JSON.parse(input.blocks_json);
        if (!Array.isArray(parsed)) {
          throw new ValidationError(
            "blocks_json must be a JSON array of Slack Block Kit block objects",
          );
        }
        blocks = parsed;
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          `blocks_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    guardDestructive({
      confirm: input.confirm,
      preview: `Update message ${input.ts} in ${input.channel} (sent as ${identityLabel(input.send_as)})`,
    });

    const args: Record<string, string | number | boolean | undefined> = {
      channel: input.channel,
      ts: input.ts,
      ...(input.text !== undefined ? { text: input.text } : {}),
    };

    if (blocks !== undefined) {
      (args as Record<string, unknown>)["blocks"] = blocks;
    }

    const resp = await context.client.updateMessage(args, input.send_as);
    return { ok: true, channel: resp.channel, ts: resp.ts };
  },
});

// ---------------------------------------------------------------------------
// delete_message
// ---------------------------------------------------------------------------

const deleteMessageInputSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  send_as: z.enum(["bot", "user"]).optional().default("user"),
  confirm: z.boolean().optional().default(false),
});

type DeleteMessageInput = z.infer<typeof deleteMessageInputSchema>;

type DeleteMessageOutput = { ok: true; channel: string; ts: string };

export const delete_message = defineTool<
  DeleteMessageInput,
  DeleteMessageOutput,
  SlackContext
>({
  name: "delete_message",
  description: "Delete a message by channel and timestamp.",
  // Cast required: ZodDefault on send_as/confirm widens schema input type.
  inputSchema: deleteMessageInputSchema as unknown as z.ZodType<DeleteMessageInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Delete message ${input.ts} in ${input.channel} (sent as ${identityLabel(input.send_as)})`,
    });

    const resp = await context.client.deleteMessage(
      { channel: input.channel, ts: input.ts },
      input.send_as,
    );
    return { ok: true, channel: resp.channel, ts: resp.ts };
  },
});

// ---------------------------------------------------------------------------
// schedule_message
// ---------------------------------------------------------------------------

const scheduleMessageInputSchema = z.object({
  channel: z.string().min(1),
  post_at: z.number().int(),
  text: z.string().min(1),
  thread_ts: z.string().optional(),
  send_as: z.enum(["bot", "user"]).optional().default("user"),
  confirm: z.boolean().optional().default(false),
});

type ScheduleMessageInput = z.infer<typeof scheduleMessageInputSchema>;

type ScheduleMessageOutput = {
  ok: true;
  channel: string;
  scheduled_message_id: string;
  post_at: number;
};

export const schedule_message = defineTool<
  ScheduleMessageInput,
  ScheduleMessageOutput,
  SlackContext
>({
  name: "schedule_message",
  description: "Schedule a message to be sent at a future unix timestamp.",
  // Cast required: ZodDefault on send_as/confirm widens schema input type.
  inputSchema: scheduleMessageInputSchema as unknown as z.ZodType<ScheduleMessageInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Schedule message to ${input.channel} at ${input.post_at} (unix): "${truncate(input.text)}"`,
    });

    const args: Record<string, string | number | boolean | undefined> = {
      channel: input.channel,
      post_at: input.post_at,
      text: input.text,
      ...(input.thread_ts !== undefined ? { thread_ts: input.thread_ts } : {}),
    };

    const resp = await context.client.scheduleMessage(args, input.send_as);
    return {
      ok: true,
      channel: resp.channel,
      scheduled_message_id: resp.scheduled_message_id,
      post_at: resp.post_at,
    };
  },
});
