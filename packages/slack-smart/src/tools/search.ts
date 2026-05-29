import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { nullableString, nullableNumber, asObject } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// Slim mappers (single-use; defined here rather than shared)
// ---------------------------------------------------------------------------

type SlimSearchMatch = {
  ts: string;
  text: string;
  user?: string;
  username?: string;
  channel_id?: string;
  channel_name?: string;
  permalink?: string;
};

type SlimFile = {
  id: string;
  name?: string;
  title?: string;
  filetype?: string;
  permalink?: string;
  user?: string;
  created?: number;
};

function mapSearchMatch(raw: unknown): SlimSearchMatch {
  const obj = asObject(raw);
  const ts = nullableString(obj["ts"]) ?? "";
  const text = nullableString(obj["text"]) ?? "";
  const slim: SlimSearchMatch = { ts, text };

  const user = nullableString(obj["user"]);
  if (user !== null) slim.user = user;

  const username = nullableString(obj["username"]);
  if (username !== null) slim.username = username;

  const channel = asObject(obj["channel"]);
  const channel_id = nullableString(channel["id"]);
  if (channel_id !== null) slim.channel_id = channel_id;
  const channel_name = nullableString(channel["name"]);
  if (channel_name !== null) slim.channel_name = channel_name;

  const permalink = nullableString(obj["permalink"]);
  if (permalink !== null) slim.permalink = permalink;

  return slim;
}

function mapSlimFile(raw: unknown): SlimFile {
  const obj = asObject(raw);
  const id = nullableString(obj["id"]) ?? "";
  const slim: SlimFile = { id };

  const name = nullableString(obj["name"]);
  if (name !== null) slim.name = name;

  const title = nullableString(obj["title"]);
  if (title !== null) slim.title = title;

  const filetype = nullableString(obj["filetype"]);
  if (filetype !== null) slim.filetype = filetype;

  const permalink = nullableString(obj["permalink"]);
  if (permalink !== null) slim.permalink = permalink;

  const user = nullableString(obj["user"]);
  if (user !== null) slim.user = user;

  const created = nullableNumber(obj["created"]);
  if (created !== null) slim.created = created;

  return slim;
}

// ---------------------------------------------------------------------------
// search_messages
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on count/sort/sort_dir/cursor widens schema input
// type vs the resolved type the handler receives.
const searchMessagesInputSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(100).optional().default(20),
  sort: z.enum(["score", "timestamp"]).optional().default("score"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
  cursor: z.string().optional().default("*"),
});

type SearchMessagesInput = z.infer<typeof searchMessagesInputSchema>;

type SearchMessagesOutput = {
  matches: SlimSearchMatch[];
  total: number;
  next_cursor?: string;
};

export const search_messages = defineTool<
  SearchMessagesInput,
  SearchMessagesOutput,
  SlackContext
>({
  name: "search_messages",
  description: "Search messages across the workspace (user token, scope search:read).",
  inputSchema: searchMessagesInputSchema as unknown as z.ZodType<SearchMessagesInput>,
  handler: async (input, context) => {
    const resp = await context.client.searchMessages({
      query: input.query,
      count: input.count,
      sort: input.sort,
      sort_dir: input.sort_dir,
      cursor: input.cursor,
    });
    const matches = resp.messages.matches.map(mapSearchMatch);
    const total = resp.messages.total;
    const next = resp.response_metadata?.next_cursor;
    return {
      matches,
      total,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on count/sort/sort_dir/cursor widens schema input
// type vs the resolved type the handler receives.
const searchFilesInputSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(100).optional().default(20),
  sort: z.enum(["score", "timestamp"]).optional().default("score"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
  cursor: z.string().optional().default("*"),
});

type SearchFilesInput = z.infer<typeof searchFilesInputSchema>;

type SearchFilesOutput = {
  files: SlimFile[];
  total: number;
  next_cursor?: string;
};

export const search_files = defineTool<
  SearchFilesInput,
  SearchFilesOutput,
  SlackContext
>({
  name: "search_files",
  description: "Search files across the workspace (user token, scope search:read).",
  inputSchema: searchFilesInputSchema as unknown as z.ZodType<SearchFilesInput>,
  handler: async (input, context) => {
    const resp = await context.client.searchFiles({
      query: input.query,
      count: input.count,
      sort: input.sort,
      sort_dir: input.sort_dir,
      cursor: input.cursor,
    });
    const files = resp.files.matches.map(mapSlimFile);
    const total = resp.files.total;
    const next = resp.response_metadata?.next_cursor;
    return {
      files,
      total,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});
