import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapFile, type SlimFile } from "../file-mapper.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

// =============================================================================
// trash (files.update trashed:true — REVERSIBLE, the safe default "delete")
// =============================================================================

const trashInputSchema = z.object({
  file_id: z.string().min(1),
});

type TrashInput = z.infer<typeof trashInputSchema>;
type TrashOutput = { file: SlimFile };

export const trashTool = defineTool<TrashInput, TrashOutput, GDriveContext>({
  name: "trash",
  description: "Move a file to trash (recoverable)",
  inputSchema: trashInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.updateFile(input.file_id, { trashed: true });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// restore (files.update trashed:false)
// =============================================================================

const restoreInputSchema = z.object({
  file_id: z.string().min(1),
});

type RestoreInput = z.infer<typeof restoreInputSchema>;
type RestoreOutput = { file: SlimFile };

export const restoreTool = defineTool<
  RestoreInput,
  RestoreOutput,
  GDriveContext
>({
  name: "restore",
  description: "Restore a file from trash",
  inputSchema: restoreInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.updateFile(input.file_id, { trashed: false });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// delete (files.delete — PERMANENT, hard confirm-gated)
// =============================================================================

const deleteInputSchema = z.object({
  file_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteInput = z.input<typeof deleteInputSchema>;
type DeleteParsed = z.infer<typeof deleteInputSchema>;
type DeleteOutput = { deleted: true };

export const deleteTool = defineTool<DeleteInput, DeleteOutput, GDriveContext>({
  name: "delete",
  description: "Permanently delete a file",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema: deleteInputSchema as unknown as z.ZodType<DeleteInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteParsed;
    // Resolve the target first so the preview can warn when this is a FOLDER —
    // files.delete on a folder recursively destroys every descendant the user
    // owns, bypassing Trash entirely (M2).
    const raw = await ctx.client.getFile(parsed.file_id, "id,name,mimeType");
    const isFolder =
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>).mimeType === FOLDER_MIME;
    const scope = isFolder
      ? `folder \`${parsed.file_id}\` and ALL its contents (recursive, irreversible)`
      : `file \`${parsed.file_id}\``;
    const preview =
      `Permanently delete ${scope}. ` +
      "This is permanent, cannot be undone (bypasses Trash). " +
      "Use `trash` instead to keep it recoverable for 30 days.";
    guardDestructive({ confirm: parsed.confirm, preview });
    await ctx.client.deleteFile(parsed.file_id);
    return { deleted: true };
  },
});

// =============================================================================
// empty_trash (files.emptyTrash — dry_run default true, then hard-gated)
// =============================================================================

const emptyTrashInputSchema = z.object({
  dry_run: z.boolean().default(true),
  confirm: z.boolean().optional().default(false),
});

type EmptyTrashInput = z.input<typeof emptyTrashInputSchema>;
type EmptyTrashParsed = z.infer<typeof emptyTrashInputSchema>;
type EmptyTrashOutput =
  | { dry_run: true; would_delete: SlimFile[]; count: number }
  | { emptied: true; deleted_count: number };

export const emptyTrashTool = defineTool<
  EmptyTrashInput,
  EmptyTrashOutput,
  GDriveContext
>({
  name: "empty_trash",
  description: "Permanently empty the trash",
  // Cast required because `dry_run`/`confirm` use `.default(...)`.
  inputSchema:
    emptyTrashInputSchema as unknown as z.ZodType<EmptyTrashInput>,
  handler: async (input, ctx) => {
    const parsed = input as EmptyTrashParsed;
    // Enumerate EVERY trashed file, paginating through nextPageToken. `emptyTrash`
    // wipes the entire trash, so a single 100-item page would under-report the
    // real blast radius in both the dry-run payload and the confirm preview (M1).
    const files: SlimFile[] = [];
    let pageToken: string | undefined;
    do {
      const listed = await ctx.client.listFiles({
        q: "trashed=true",
        pageSize: 100,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const raw of listed.files) files.push(mapFile(raw));
      pageToken = listed.nextPageToken;
    } while (pageToken !== undefined);

    if (parsed.dry_run) {
      return { dry_run: true, would_delete: files, count: files.length };
    }
    const preview =
      `Permanently delete ALL ${files.length} trashed file(s). ` +
      "empty_trash removes EVERY trashed file in your Drive, not just this page. " +
      "This is permanent, cannot be undone.";
    guardDestructive({ confirm: parsed.confirm, preview });
    await ctx.client.emptyTrash();
    return { emptied: true, deleted_count: files.length };
  },
});
