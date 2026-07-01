import { existsSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import {
  uploadMultipart,
  updateContent,
  downloadMedia,
  exportDoc,
  validateMimeType,
  assertNoTraversal,
} from "../media.js";

// =============================================================================
// Shared slim shape for the create/replace tools. Kept self-contained here (no
// dependency on the JSON half's file-mapper) so the media layer stays isolated.
// =============================================================================

/** Minimal file shape returned by `upload` / `update_content`. */
type MediaFileOutput = {
  file_id: string;
  name: string;
  web_view_link: string | null;
  mime_type: string;
  size: string | null;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Extract the minimal media-file shape from a raw Drive File resource. */
function shapeMediaFile(raw: Record<string, unknown>): MediaFileOutput {
  return {
    file_id: str(raw.id),
    name: str(raw.name),
    web_view_link: strOrNull(raw.webViewLink),
    mime_type: str(raw.mimeType),
    size: strOrNull(raw.size),
  };
}

/** Bound token getter for the media layer's raw fetch calls. */
function tokenGetterOf(ctx: GDriveContext): () => Promise<string> {
  return () => ctx.client.accessToken();
}

/** Fail fast (before any network) when a caller-supplied local file is absent. */
function assertLocalFileExists(localPath: string): void {
  if (!existsSync(localPath)) {
    throw new ValidationError(`Local file not found: \`${localPath}\``);
  }
}

// =============================================================================
// upload (multipart create from a local file)
// =============================================================================

const uploadInputSchema = z.object({
  local_path: z.string().min(1),
  name: z.string().min(1).optional(),
  parent_id: z.string().optional(),
  mime_type: z.string().optional(),
});

type UploadInput = z.infer<typeof uploadInputSchema>;

export const uploadTool = defineTool<UploadInput, MediaFileOutput, GDriveContext>({
  name: "upload",
  description: "Upload a local file to Drive",
  inputSchema: uploadInputSchema,
  handler: async (input, ctx) => {
    assertNoTraversal(input.local_path);
    if (input.mime_type !== undefined) validateMimeType(input.mime_type);
    assertLocalFileExists(input.local_path);
    const name = input.name ?? basename(input.local_path);
    const raw = await uploadMultipart(
      tokenGetterOf(ctx),
      {
        name,
        localPath: input.local_path,
        ...(input.parent_id !== undefined ? { parents: [input.parent_id] } : {}),
        ...(input.mime_type !== undefined ? { mimeType: input.mime_type } : {}),
      },
      ctx.client.getAccount(),
    );
    return shapeMediaFile(raw);
  },
});

// =============================================================================
// update_content (replace an existing file's bytes)
// =============================================================================

const updateContentInputSchema = z.object({
  file_id: z.string().min(1),
  local_path: z.string().min(1),
  mime_type: z.string().optional(),
});

type UpdateContentInput = z.infer<typeof updateContentInputSchema>;

export const updateContentTool = defineTool<
  UpdateContentInput,
  MediaFileOutput,
  GDriveContext
>({
  name: "update_content",
  description: "Replace a file's contents from a local file",
  inputSchema: updateContentInputSchema,
  handler: async (input, ctx) => {
    assertNoTraversal(input.local_path);
    if (input.mime_type !== undefined) validateMimeType(input.mime_type);
    assertLocalFileExists(input.local_path);
    const raw = await updateContent(
      tokenGetterOf(ctx),
      input.file_id,
      {
        localPath: input.local_path,
        ...(input.mime_type !== undefined ? { mimeType: input.mime_type } : {}),
      },
      ctx.client.getAccount(),
    );
    return shapeMediaFile(raw);
  },
});

// =============================================================================
// download (blob bytes -> local path)
// =============================================================================

const downloadInputSchema = z.object({
  file_id: z.string().min(1),
  dest_path: z.string().min(1),
  /** Refuse to clobber an existing dest_path unless this is true (M4). */
  overwrite: z.boolean().optional().default(false),
});

type DownloadInput = z.input<typeof downloadInputSchema>;
type DownloadParsed = z.infer<typeof downloadInputSchema>;
type DownloadOutput = { path: string; bytes: number };

export const downloadTool = defineTool<
  DownloadInput,
  DownloadOutput,
  GDriveContext
>({
  name: "download",
  description: "Download a file's bytes to a local path",
  // Cast required because `overwrite` has `.optional().default(...)`.
  inputSchema: downloadInputSchema as unknown as z.ZodType<DownloadInput>,
  handler: async (input, ctx) => {
    const parsed = input as DownloadParsed;
    assertNoTraversal(parsed.dest_path);
    return downloadMedia(
      tokenGetterOf(ctx),
      parsed.file_id,
      parsed.dest_path,
      ctx.client.getAccount(),
      parsed.overwrite,
    );
  },
});

// =============================================================================
// export_file (Google-native doc -> chosen format -> local path)
// =============================================================================

const exportFileInputSchema = z.object({
  file_id: z.string().min(1),
  /** Target export MIME type, e.g. `application/pdf`. */
  mime_type: z.string().min(1),
  dest_path: z.string().min(1),
  /** Refuse to clobber an existing dest_path unless this is true (M4). */
  overwrite: z.boolean().optional().default(false),
});

type ExportFileInput = z.input<typeof exportFileInputSchema>;
type ExportFileParsed = z.infer<typeof exportFileInputSchema>;
type ExportFileOutput = { path: string; bytes: number; mime_type: string };

export const exportFileTool = defineTool<
  ExportFileInput,
  ExportFileOutput,
  GDriveContext
>({
  name: "export_file",
  description: "Export a Google doc to a local file",
  // Cast required because `overwrite` has `.optional().default(...)`.
  inputSchema: exportFileInputSchema as unknown as z.ZodType<ExportFileInput>,
  handler: async (input, ctx) => {
    const parsed = input as ExportFileParsed;
    assertNoTraversal(parsed.dest_path);
    return exportDoc(
      tokenGetterOf(ctx),
      parsed.file_id,
      parsed.mime_type,
      parsed.dest_path,
      ctx.client.getAccount(),
      parsed.overwrite,
    );
  },
});
