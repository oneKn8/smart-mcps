import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapFile, type SlimFile } from "../file-mapper.js";

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
      q = `'${input.folder_id}' in parents and trashed = false`;
    }
    const listed = await ctx.client.listFiles({
      ...(q !== undefined ? { q } : {}),
      ...(input.page_size !== undefined ? { pageSize: input.page_size } : {}),
      ...(input.page_token !== undefined
        ? { pageToken: input.page_token }
        : {}),
    });
    return {
      files: listed.files.map(mapFile),
      ...(listed.nextPageToken !== undefined
        ? { next_page_token: listed.nextPageToken }
        : {}),
    };
  },
});
