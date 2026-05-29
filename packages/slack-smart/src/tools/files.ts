import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { SlackContext } from "../context.js";

// ---------------------------------------------------------------------------
// SlimFile mapper
// ---------------------------------------------------------------------------

export type SlimFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  permalink?: string;
  permalink_public?: string;
  user?: string;
  created?: number;
  channels?: string[];
};

function slimFile(raw: unknown): SlimFile {
  const f = raw as Record<string, unknown>;
  const id = typeof f["id"] === "string" ? f["id"] : String(f["id"] ?? "");
  return {
    id,
    ...(typeof f["name"] === "string" ? { name: f["name"] } : {}),
    ...(typeof f["title"] === "string" ? { title: f["title"] } : {}),
    ...(typeof f["mimetype"] === "string" ? { mimetype: f["mimetype"] } : {}),
    ...(typeof f["filetype"] === "string" ? { filetype: f["filetype"] } : {}),
    ...(typeof f["size"] === "number" ? { size: f["size"] } : {}),
    ...(typeof f["permalink"] === "string"
      ? { permalink: f["permalink"] }
      : {}),
    ...(typeof f["permalink_public"] === "string"
      ? { permalink_public: f["permalink_public"] }
      : {}),
    ...(typeof f["user"] === "string" ? { user: f["user"] } : {}),
    ...(typeof f["created"] === "number" ? { created: f["created"] } : {}),
    ...(Array.isArray(f["channels"])
      ? {
          channels: (f["channels"] as unknown[]).filter(
            (c): c is string => typeof c === "string",
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const listFilesInputSchema = z.object({
  channel: z.string().optional(),
  user: z.string().optional(),
  // Cast required: ZodDefault widens schema input type vs resolved output type.
  count: z.number().int().min(1).max(100).optional().default(100),
  page: z.number().int().min(1).optional().default(1),
  types: z.string().optional(),
});

type ListFilesInput = z.infer<typeof listFilesInputSchema>;

type ListFilesOutput = {
  files: SlimFile[];
  count: number;
  page?: number;
  pages?: number;
  total?: number;
};

export const list_files = defineTool<ListFilesInput, ListFilesOutput, SlackContext>({
  name: "list_files",
  description: "List files visible to the user token.",
  // Cast required: ZodDefault on count/page widens schema input type.
  inputSchema: listFilesInputSchema as unknown as z.ZodType<ListFilesInput>,
  handler: async (input, context) => {
    const resp = await context.client.listFiles({
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.user !== undefined ? { user: input.user } : {}),
      count: input.count,
      page: input.page,
      ...(input.types !== undefined ? { types: input.types } : {}),
    });
    const files = resp.files.map(slimFile);
    const paging = resp.paging;
    return {
      files,
      count: files.length,
      ...(paging !== undefined ? { page: paging.page } : {}),
      ...(paging !== undefined ? { pages: paging.pages } : {}),
      ...(paging !== undefined ? { total: paging.total } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// file_info
// ---------------------------------------------------------------------------

const fileInfoInputSchema = z.object({
  file: z.string().min(1),
});

type FileInfoInput = z.infer<typeof fileInfoInputSchema>;

export const file_info = defineTool<FileInfoInput, SlimFile, SlackContext>({
  name: "file_info",
  description: "Get metadata for a single file by ID.",
  inputSchema: fileInfoInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getFileInfo({ file: input.file });
    return slimFile(resp.file);
  },
});

// ---------------------------------------------------------------------------
// upload_file
// ---------------------------------------------------------------------------

const uploadFileInputSchema = z.object({
  file_path: z.string().optional(),
  content_base64: z.string().optional(),
  filename: z.string().optional(),
  title: z.string().optional(),
  channel_id: z.string().optional(),
  initial_comment: z.string().optional(),
  thread_ts: z.string().optional(),
  // Cast required: ZodDefault widens schema input type.
  confirm: z.boolean().optional().default(false),
});

type UploadFileInput = z.infer<typeof uploadFileInputSchema>;

type UploadFileOutput = {
  ok: true;
  file_id: string;
  files?: SlimFile[];
};

export const upload_file = defineTool<UploadFileInput, UploadFileOutput, SlackContext>({
  name: "upload_file",
  description: "Upload a file to Slack via the 3-step external upload flow.",
  // Cast required: ZodDefault on confirm widens schema input type.
  inputSchema: uploadFileInputSchema as unknown as z.ZodType<UploadFileInput>,
  handler: async (input, context) => {
    const hasPath = input.file_path !== undefined;
    const hasBase64 = input.content_base64 !== undefined;

    if (!hasPath && !hasBase64) {
      throw new ValidationError(
        "upload_file requires exactly one of file_path or content_base64",
      );
    }
    if (hasPath && hasBase64) {
      throw new ValidationError(
        "upload_file requires exactly one of file_path or content_base64, not both",
      );
    }
    if (hasBase64 && input.filename === undefined) {
      throw new ValidationError(
        "filename is required when using content_base64",
      );
    }

    let bytes: Uint8Array;
    let filename: string;

    if (hasPath) {
      // file_path branch — may throw if file not found; let it propagate
      const fileBytes = readFileSync(input.file_path as string);
      bytes = new Uint8Array(fileBytes);
      filename = input.filename ?? basename(input.file_path as string);
    } else {
      bytes = new Uint8Array(
        Buffer.from(input.content_base64 as string, "base64"),
      );
      // filename required guard already validated above
      filename = input.filename as string;
    }

    const length = bytes.length;

    guardDestructive({
      confirm: input.confirm,
      preview: `Upload "${filename}" (${length} bytes) to ${input.channel_id ?? "(no channel)"}`,
    });

    // Step 1: get upload URL
    const { upload_url, file_id } = await context.client.getUploadUrl({
      filename,
      length,
    });

    // Step 2: POST raw bytes to the pre-signed URL
    await context.client.uploadBytes(upload_url, bytes, filename);

    // Step 3: complete the upload
    const completeResp = await context.client.completeUpload({
      files: [
        {
          id: file_id,
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
      ],
      ...(input.channel_id !== undefined ? { channel_id: input.channel_id } : {}),
      ...(input.initial_comment !== undefined
        ? { initial_comment: input.initial_comment }
        : {}),
      ...(input.thread_ts !== undefined ? { thread_ts: input.thread_ts } : {}),
    });

    return {
      ok: true,
      file_id,
      ...(Array.isArray(completeResp.files) && completeResp.files.length > 0
        ? { files: completeResp.files.map(slimFile) }
        : {}),
    };
  },
});
