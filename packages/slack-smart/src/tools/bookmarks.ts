import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SlackContext } from "../context.js";

// ---------------------------------------------------------------------------
// SlimBookmark mapper
// ---------------------------------------------------------------------------

export type SlimBookmark = {
  id: string;
  title?: string;
  link?: string;
  emoji?: string;
  type?: string;
  channel_id?: string;
};

function slimBookmark(raw: unknown): SlimBookmark {
  const b = raw as Record<string, unknown>;
  const id = typeof b["id"] === "string" ? b["id"] : String(b["id"] ?? "");
  return {
    id,
    ...(typeof b["title"] === "string" ? { title: b["title"] } : {}),
    ...(typeof b["link"] === "string" ? { link: b["link"] } : {}),
    ...(typeof b["emoji"] === "string" ? { emoji: b["emoji"] } : {}),
    ...(typeof b["type"] === "string" ? { type: b["type"] } : {}),
    ...(typeof b["channel_id"] === "string"
      ? { channel_id: b["channel_id"] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// list_bookmarks (read-only, scope bookmarks:read)
// ---------------------------------------------------------------------------

const listBookmarksInputSchema = z.object({
  channel_id: z.string().min(1),
});

type ListBookmarksInput = z.infer<typeof listBookmarksInputSchema>;

type ListBookmarksOutput = { bookmarks: SlimBookmark[]; count: number };

export const list_bookmarks = defineTool<
  ListBookmarksInput,
  ListBookmarksOutput,
  SlackContext
>({
  name: "list_bookmarks",
  description: "List a channel's bookmarks.",
  inputSchema: listBookmarksInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.listBookmarks({
      channel_id: input.channel_id,
    });
    const bookmarks = resp.bookmarks.map(slimBookmark);
    return { bookmarks, count: bookmarks.length };
  },
});

// ---------------------------------------------------------------------------
// add_bookmark (write — confirm-gated, scope bookmarks:write)
// ---------------------------------------------------------------------------

const addBookmarkInputSchema = z.object({
  channel_id: z.string().min(1),
  title: z.string().min(1),
  link: z.string().optional(),
  // Slack currently only supports "link" type bookmarks via the API.
  type: z.string().optional().default("link"),
  emoji: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type AddBookmarkInput = z.infer<typeof addBookmarkInputSchema>;

export const add_bookmark = defineTool<
  AddBookmarkInput,
  { ok: true; bookmark: SlimBookmark },
  SlackContext
>({
  name: "add_bookmark",
  description: "Add a bookmark to a channel (write — confirm-gated).",
  // Cast required: ZodDefault on type/confirm widens schema input type.
  inputSchema: addBookmarkInputSchema as unknown as z.ZodType<AddBookmarkInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Add bookmark "${input.title}" to ${input.channel_id}`,
    });
    const resp = await context.client.addBookmark({
      channel_id: input.channel_id,
      title: input.title,
      type: input.type,
      ...(input.link !== undefined ? { link: input.link } : {}),
      ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
    });
    return { ok: true, bookmark: slimBookmark(resp.bookmark) };
  },
});

// ---------------------------------------------------------------------------
// edit_bookmark (write — confirm-gated, scope bookmarks:write)
// ---------------------------------------------------------------------------

const editBookmarkInputSchema = z.object({
  channel_id: z.string().min(1),
  bookmark_id: z.string().min(1),
  title: z.string().optional(),
  link: z.string().optional(),
  emoji: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type EditBookmarkInput = z.infer<typeof editBookmarkInputSchema>;

export const edit_bookmark = defineTool<
  EditBookmarkInput,
  { ok: true; bookmark: SlimBookmark },
  SlackContext
>({
  name: "edit_bookmark",
  description: "Edit a channel bookmark (write — confirm-gated).",
  // Cast required: ZodDefault on confirm widens schema input type.
  inputSchema: editBookmarkInputSchema as unknown as z.ZodType<EditBookmarkInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Edit bookmark ${input.bookmark_id} in ${input.channel_id}`,
    });
    const resp = await context.client.editBookmark({
      channel_id: input.channel_id,
      bookmark_id: input.bookmark_id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.link !== undefined ? { link: input.link } : {}),
      ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
    });
    return { ok: true, bookmark: slimBookmark(resp.bookmark) };
  },
});

// ---------------------------------------------------------------------------
// remove_bookmark (write — confirm-gated, scope bookmarks:write)
// ---------------------------------------------------------------------------

const removeBookmarkInputSchema = z.object({
  channel_id: z.string().min(1),
  bookmark_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type RemoveBookmarkInput = z.infer<typeof removeBookmarkInputSchema>;

export const remove_bookmark = defineTool<
  RemoveBookmarkInput,
  { ok: true; bookmark_id: string },
  SlackContext
>({
  name: "remove_bookmark",
  description: "Remove a channel bookmark (write — confirm-gated).",
  // Cast required: ZodDefault on confirm widens schema input type.
  inputSchema: removeBookmarkInputSchema as unknown as z.ZodType<RemoveBookmarkInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Remove bookmark ${input.bookmark_id} from ${input.channel_id}`,
    });
    await context.client.removeBookmark({
      channel_id: input.channel_id,
      bookmark_id: input.bookmark_id,
    });
    return { ok: true, bookmark_id: input.bookmark_id };
  },
});
