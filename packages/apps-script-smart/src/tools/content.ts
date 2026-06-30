import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import {
  mapContent,
  toFileWritePayload,
  type SlimContent,
  type FileWritePayload,
} from "../content-mapper.js";

const fileTypeSchema = z.enum(["SERVER_JS", "HTML", "JSON"]);

// =============================================================================
// get_content
// =============================================================================

const getContentInputSchema = z.object({
  script_id: z.string().min(1),
  /** Version to read; omit for HEAD (the live, editable code). */
  version_number: z.number().int().optional(),
});

type GetContentInput = z.infer<typeof getContentInputSchema>;
type GetContentOutput = { content: SlimContent };

export const getContentTool = defineTool<
  GetContentInput,
  GetContentOutput,
  AppsScriptContext
>({
  name: "get_content",
  description: "Get a project's files and manifest",
  inputSchema: getContentInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getContent(
      input.script_id,
      input.version_number,
    );
    return { content: mapContent(raw) };
  },
});

// =============================================================================
// update_content (destructive — FULL OVERWRITE, confirm-gated)
// =============================================================================

const updateContentInputSchema = z.object({
  script_id: z.string().min(1),
  /**
   * The COMPLETE file set. This REPLACES every file in the project; any
   * existing file omitted here is DELETED. Exactly one file must be the
   * `appsscript` JSON manifest. Prefer `push_file` for single-file edits.
   */
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        type: fileTypeSchema,
        source: z.string(),
      }),
    )
    .min(1),
  confirm: z.boolean().optional().default(false),
});

type UpdateContentInput = z.input<typeof updateContentInputSchema>;
type UpdateContentParsed = z.infer<typeof updateContentInputSchema>;
type UpdateContentOutput = { content: SlimContent };

export const updateContentTool = defineTool<
  UpdateContentInput,
  UpdateContentOutput,
  AppsScriptContext
>({
  name: "update_content",
  description: "Overwrite ALL project files (full replace)",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    updateContentInputSchema as unknown as z.ZodType<UpdateContentInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateContentParsed;
    const names = parsed.files.map((f) => f.name);
    const hasManifest = parsed.files.some(
      (f) => f.name === "appsscript" && f.type === "JSON",
    );
    const preview =
      `Overwrite ALL files in project ${parsed.script_id}. ` +
      `Writing ${parsed.files.length} file(s): ${names.join(", ")}. ` +
      "Any existing file NOT in this list will be DELETED." +
      (hasManifest
        ? ""
        : " WARNING: no `appsscript` JSON manifest is included — Google will reject this.");
    guardDestructive({ confirm: parsed.confirm, preview });

    const files: FileWritePayload[] = parsed.files.map((f) => ({
      name: f.name,
      type: f.type,
      source: f.source,
    }));
    const raw = await ctx.client.updateContent(parsed.script_id, files);
    return { content: mapContent(raw) };
  },
});

// =============================================================================
// push_file (SAFE read-modify-write wrapper over updateContent)
// =============================================================================

const pushFileInputSchema = z.object({
  script_id: z.string().min(1),
  /** Filename WITHOUT extension (e.g. `Code`, `index`, `appsscript`). */
  name: z.string().min(1),
  type: fileTypeSchema,
  source: z.string(),
});

type PushFileInput = z.infer<typeof pushFileInputSchema>;
type PushFileOutput = { content: SlimContent; replaced: boolean };

/** Extract the raw `files[]` array from a `getContent` response. */
function rawFiles(content: unknown): unknown[] {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const f = (content as { files?: unknown }).files;
    if (Array.isArray(f)) return f;
  }
  return [];
}

export const pushFileTool = defineTool<
  PushFileInput,
  PushFileOutput,
  AppsScriptContext
>({
  name: "push_file",
  description: "Add or replace one file safely",
  inputSchema: pushFileInputSchema,
  handler: async (input, ctx) => {
    // Read-modify-write: fetch the full HEAD content, re-serialize every
    // existing file (manifest included) to the writable triple, then splice
    // in the one file. This is what keeps update_content from clobbering the
    // rest of the project.
    const current = await ctx.client.getContent(input.script_id);
    const existing = rawFiles(current).map(toFileWritePayload);

    const incoming: FileWritePayload = {
      name: input.name,
      type: input.type,
      source: input.source,
    };

    // Match on BOTH name AND type. Apps Script allows a `.gs` (SERVER_JS) and a
    // `.html` (HTML) file sharing one base name; matching by name alone would
    // overwrite the sibling of a different type and emit a duplicate (name,type)
    // pair into the full-overwrite update_content.
    let replaced = false;
    const files: FileWritePayload[] = existing.map((f) => {
      if (f.name === input.name && f.type === input.type) {
        replaced = true;
        return incoming;
      }
      return f;
    });
    if (!replaced) files.push(incoming);

    const raw = await ctx.client.updateContent(input.script_id, files);
    return { content: mapContent(raw), replaced };
  },
});
