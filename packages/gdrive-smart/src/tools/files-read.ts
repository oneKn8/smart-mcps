import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapFile, type SlimFile } from "../file-mapper.js";

/**
 * Escape a user value for safe interpolation inside a Drive `q` string literal.
 * Per the search-files guide (reference §2.8), `\` and `'` are the two
 * metacharacters inside single-quoted `q` literals; escape the backslash FIRST,
 * then the quote, so a crafted `folder_id` can't break out of the literal and
 * inject clauses (L1).
 */
export function escapeQValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// =============================================================================
// get (files.get with the explicit FILE_FIELDS mask)
// =============================================================================

const getInputSchema = z.object({
  file_id: z.string().min(1),
});

type GetInput = z.infer<typeof getInputSchema>;
type GetOutput = { file: SlimFile };

export const getTool = defineTool<GetInput, GetOutput, GDriveContext>({
  name: "get",
  description: "Get file metadata",
  inputSchema: getInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getFile(input.file_id);
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// list (folder children via folder_id, or a free-form q)
// =============================================================================

const listInputSchema = z.object({
  /**
   * When set (and `q` is not), lists this folder's live children via
   * `q = "'FOLDER_ID' in parents and trashed = false"`.
   */
  folder_id: z.string().optional(),
  /** Raw Drive `q` filter. Takes precedence over `folder_id` when both set. */
  q: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
  page_token: z.string().optional(),
  /** Shared-drive id to scope the listing to (enables includeItemsFromAllDrives) (L5). */
  drive_id: z.string().optional(),
  /** Search corpus for shared drives (L5). Defaults to `drive` when drive_id is set. */
  corpora: z.enum(["user", "drive", "domain", "allDrives"]).optional(),
});

type ListInput = z.infer<typeof listInputSchema>;
type ListOutput = { files: SlimFile[]; next_page_token?: string };

export const listTool = defineTool<ListInput, ListOutput, GDriveContext>({
  name: "list",
  description: "List files or folder children",
  inputSchema: listInputSchema,
  handler: async (input, ctx) => {
    let q = input.q;
    if (q === undefined && input.folder_id !== undefined) {
      q = `'${escapeQValue(input.folder_id)}' in parents and trashed = false`;
    }
    const listed = await ctx.client.listFiles({
      ...(q !== undefined ? { q } : {}),
      ...(input.page_size !== undefined ? { pageSize: input.page_size } : {}),
      ...(input.page_token !== undefined
        ? { pageToken: input.page_token }
        : {}),
      ...(input.drive_id !== undefined ? { driveId: input.drive_id } : {}),
      ...(input.corpora !== undefined ? { corpora: input.corpora } : {}),
    });
    return {
      files: listed.files.map(mapFile),
      ...(listed.nextPageToken !== undefined
        ? { next_page_token: listed.nextPageToken }
        : {}),
    };
  },
});
