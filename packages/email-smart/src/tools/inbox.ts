import { z } from "zod";
import { defineTool, NotFoundError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import {
  mapMessage,
  extractBodies,
  type SlimMessage,
} from "../message-mapper.js";

// ---------- list_inbox ----------

const listInboxInputSchema = z.object({
  account: z.string().min(1),
  max_results: z.number().int().min(1).max(100).optional().default(10),
  label: z.string().optional().default("INBOX"),
});

type ListInboxInput = z.infer<typeof listInboxInputSchema>;

type ListResultOutput = {
  messages: SlimMessage[];
  count: number;
  next_page_token?: string;
};

export const listInbox = defineTool<
  ListInboxInput,
  ListResultOutput,
  EmailContext
>({
  name: "list_inbox",
  description: "List recent inbox messages (slim shape).",
  // Cast required: ZodDefault on `max_results` and `label` widen input type.
  inputSchema: listInboxInputSchema as unknown as z.ZodType<ListInboxInput>,
  handler: async (input, context) => {
    const list = await context.client.listMessages(input.account, {
      labelIds: input.label,
      maxResults: input.max_results,
    });

    const slim: SlimMessage[] = [];
    for (const ref of list.messages) {
      const raw = await context.client.getMessage(
        input.account,
        ref.id,
        "metadata",
      );
      slim.push(mapMessage(raw));
    }

    return {
      messages: slim,
      count: slim.length,
      ...(list.nextPageToken !== undefined
        ? { next_page_token: list.nextPageToken }
        : {}),
    };
  },
});

// ---------- search_emails ----------

const searchEmailsInputSchema = z.object({
  account: z.string().min(1),
  q: z.string().min(1),
  max_results: z.number().int().min(1).max(100).optional().default(25),
});

type SearchEmailsInput = z.infer<typeof searchEmailsInputSchema>;

export const searchEmails = defineTool<
  SearchEmailsInput,
  ListResultOutput,
  EmailContext
>({
  name: "search_emails",
  description: "Search Gmail with query syntax.",
  // Cast required: ZodDefault on `max_results` widens the input type.
  inputSchema: searchEmailsInputSchema as unknown as z.ZodType<SearchEmailsInput>,
  handler: async (input, context) => {
    const list = await context.client.listMessages(input.account, {
      q: input.q,
      maxResults: input.max_results,
    });

    const slim: SlimMessage[] = [];
    for (const ref of list.messages) {
      const raw = await context.client.getMessage(
        input.account,
        ref.id,
        "metadata",
      );
      slim.push(mapMessage(raw));
    }

    return {
      messages: slim,
      count: slim.length,
      ...(list.nextPageToken !== undefined
        ? { next_page_token: list.nextPageToken }
        : {}),
    };
  },
});

// ---------- read_email ----------

const readEmailInputSchema = z.object({
  account: z.string().min(1),
  id: z.string().min(1),
  format: z.enum(["full", "metadata"]).optional().default("full"),
});

type ReadEmailInput = z.infer<typeof readEmailInputSchema>;

type ReadEmailOutput = SlimMessage & {
  body_html?: string;
  body_text?: string;
};

export const readEmail = defineTool<
  ReadEmailInput,
  ReadEmailOutput,
  EmailContext
>({
  name: "read_email",
  description: "Read full email body by ID.",
  // Cast required: ZodDefault on `format` widens the input type.
  inputSchema: readEmailInputSchema as unknown as z.ZodType<ReadEmailInput>,
  handler: async (input, context) => {
    const raw = await context.client.getMessage(
      input.account,
      input.id,
      input.format,
    );
    const slim = mapMessage(raw);

    if (input.format !== "full") {
      return slim;
    }

    const payload =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)["payload"]
        : undefined;
    const bodies = extractBodies(payload);
    return {
      ...slim,
      ...(bodies.html !== undefined ? { body_html: bodies.html } : {}),
      ...(bodies.text !== undefined ? { body_text: bodies.text } : {}),
    };
  },
});

// ---------- get_thread ----------

const getThreadInputSchema = z.object({
  account: z.string().min(1),
  id: z.string().min(1),
});

type GetThreadInput = z.infer<typeof getThreadInputSchema>;

type GetThreadOutput = {
  id: string;
  subject: string;
  message_count: number;
  messages: SlimMessage[];
};

export const getThread = defineTool<
  GetThreadInput,
  GetThreadOutput,
  EmailContext
>({
  name: "get_thread",
  description: "Read full email thread by ID.",
  inputSchema: getThreadInputSchema,
  handler: async (input, context) => {
    const thread = await context.client.getThread(
      input.account,
      input.id,
      "metadata",
    );
    const messages = thread.messages.map((m) => mapMessage(m));
    return {
      id: thread.id,
      subject: messages[0]?.subject ?? "",
      message_count: messages.length,
      messages,
    };
  },
});

// ---------- bulk_read_messages ----------

const bulkReadMessagesInputSchema = z.object({
  account: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(100),
});

type BulkReadMessagesInput = z.infer<typeof bulkReadMessagesInputSchema>;

type BulkReadEntry = SlimMessage | { id: string; error: string };

type BulkReadOutput = {
  messages: BulkReadEntry[];
  count: number;
  errors: number;
};

export const bulkReadMessages = defineTool<
  BulkReadMessagesInput,
  BulkReadOutput,
  EmailContext
>({
  name: "bulk_read_messages",
  description: "Fetch slim shape for many message IDs at once.",
  inputSchema: bulkReadMessagesInputSchema,
  handler: async (input, context) => {
    const out: BulkReadEntry[] = [];
    let errors = 0;
    for (const id of input.ids) {
      try {
        const raw = await context.client.getMessage(
          input.account,
          id,
          "metadata",
        );
        out.push(mapMessage(raw));
      } catch (err) {
        if (err instanceof NotFoundError) {
          out.push({ id, error: "not_found" });
          errors++;
          continue;
        }
        throw err;
      }
    }
    return { messages: out, count: out.length, errors };
  },
});
