import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapFile, type SlimFile } from "../file-mapper.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

// =============================================================================
// rename
// =============================================================================

const renameInputSchema = z.object({
  file_id: z.string().min(1),
  name: z.string().min(1),
});

type RenameInput = z.infer<typeof renameInputSchema>;
type RenameOutput = { file: SlimFile };

export const renameTool = defineTool<RenameInput, RenameOutput, GDriveContext>({
  name: "rename",
  description: "Rename a file or folder",
  inputSchema: renameInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.updateFile(input.file_id, {
      name: input.name,
    });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// move (files.update via addParents/removeParents query params, empty body)
// =============================================================================

const moveInputSchema = z.object({
  file_id: z.string().min(1),
  new_parent: z.string().min(1),
  /**
   * The parent to detach from. When omitted, the tool reads the file's current
   * parent(s) via `getFile` and removes them — the common single-parent move.
   */
  remove_parent: z.string().optional(),
});

type MoveInput = z.infer<typeof moveInputSchema>;
type MoveOutput = { file: SlimFile };

export const moveTool = defineTool<MoveInput, MoveOutput, GDriveContext>({
  name: "move",
  description: "Move a file to another folder",
  inputSchema: moveInputSchema,
  handler: async (input, ctx) => {
    let removeParents = input.remove_parent;
    if (removeParents === undefined) {
      // A Drive file has one parent, but read the actual current parent(s) so
      // the move detaches from wherever the file really lives (§2.3).
      const current = mapFile(await ctx.client.getFile(input.file_id));
      if (current.parents.length > 0) {
        removeParents = current.parents.join(",");
      }
    }
    const raw = await ctx.client.updateFile(
      input.file_id,
      {},
      {
        addParents: input.new_parent,
        ...(removeParents !== undefined ? { removeParents } : {}),
      },
    );
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// star (toggle starred; defaults to starring)
// =============================================================================

const starInputSchema = z.object({
  file_id: z.string().min(1),
  starred: z.boolean().optional().default(true),
});

type StarInput = z.input<typeof starInputSchema>;
type StarParsed = z.infer<typeof starInputSchema>;
type StarOutput = { file: SlimFile };

export const starTool = defineTool<StarInput, StarOutput, GDriveContext>({
  name: "star",
  description: "Star or unstar a file",
  // Cast required because `starred` has `.optional().default(...)`.
  inputSchema: starInputSchema as unknown as z.ZodType<StarInput>,
  handler: async (input, ctx) => {
    const parsed = input as StarParsed;
    const raw = await ctx.client.updateFile(parsed.file_id, {
      starred: parsed.starred,
    });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// update_metadata (name / description / starred in one call)
// =============================================================================

const updateMetadataInputSchema = z.object({
  file_id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  starred: z.boolean().optional(),
});

type UpdateMetadataInput = z.infer<typeof updateMetadataInputSchema>;
type UpdateMetadataOutput = { file: SlimFile };

export const updateMetadataTool = defineTool<
  UpdateMetadataInput,
  UpdateMetadataOutput,
  GDriveContext
>({
  name: "update_metadata",
  description: "Update file name, description, or star",
  inputSchema: updateMetadataInputSchema,
  handler: async (input, ctx) => {
    const body: {
      name?: string;
      description?: string;
      starred?: boolean;
    } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.starred !== undefined) body.starred = input.starred;
    if (Object.keys(body).length === 0) {
      throw new ValidationError(
        "update_metadata requires at least one of: name, description, starred.",
      );
    }
    const raw = await ctx.client.updateFile(input.file_id, body);
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// copy (files.copy — individual files only; folders rejected)
// =============================================================================

const copyInputSchema = z.object({
  file_id: z.string().min(1),
  name: z.string().optional(),
  parent_id: z.string().optional(),
});

type CopyInput = z.infer<typeof copyInputSchema>;
type CopyOutput = { file: SlimFile };

export const copyTool = defineTool<CopyInput, CopyOutput, GDriveContext>({
  name: "copy",
  description: "Copy a file",
  inputSchema: copyInputSchema,
  handler: async (input, ctx) => {
    // Drive cannot copy folders — resolve the source first and reject folders
    // with an actionable message instead of surfacing Google's opaque 403.
    const src = mapFile(await ctx.client.getFile(input.file_id));
    if (src.mime_type === FOLDER_MIME) {
      throw new ValidationError(
        "Cannot copy a folder — Drive only copies individual files. " +
          "Create a folder and copy its children, or use create_shortcut.",
      );
    }
    const raw = await ctx.client.copyFile(input.file_id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
    });
    return { file: mapFile(raw) };
  },
});
