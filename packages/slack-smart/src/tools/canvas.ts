import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SlackContext } from "../context.js";

// ---------------------------------------------------------------------------
// create_canvas
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens the schema input type.
const createCanvasInputSchema = z.object({
  title: z.string().optional(),
  markdown: z.string().optional(),
  channel_id: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type CreateCanvasInput = z.infer<typeof createCanvasInputSchema>;

type CreateCanvasOutput = { ok: true; canvas_id: string };

export const create_canvas = defineTool<
  CreateCanvasInput,
  CreateCanvasOutput,
  SlackContext
>({
  name: "create_canvas",
  description:
    "Create a standalone canvas with optional markdown content (user token, scope canvases:write).",
  inputSchema: createCanvasInputSchema as unknown as z.ZodType<CreateCanvasInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Create canvas${input.title !== undefined ? ` "${input.title}"` : ""}`,
    });
    const resp = await context.client.createCanvas({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
      ...(input.channel_id !== undefined ? { channel_id: input.channel_id } : {}),
    });
    return { ok: true, canvas_id: resp.canvas_id };
  },
});

// ---------------------------------------------------------------------------
// update_canvas
// ---------------------------------------------------------------------------

// Each change maps to a Slack canvases.edit operation. insert_*/replace carry
// markdown (wrapped into document_content); delete carries only section_id.
const canvasChangeSchema = z.object({
  operation: z.enum([
    "insert_after",
    "insert_before",
    "insert_at_start",
    "insert_at_end",
    "replace",
    "delete",
  ]),
  section_id: z.string().optional(),
  markdown: z.string().optional(),
});

const updateCanvasInputSchema = z.object({
  canvas_id: z.string().min(1),
  changes: z.array(canvasChangeSchema).min(1),
  confirm: z.boolean().optional().default(false),
});

type UpdateCanvasInput = z.infer<typeof updateCanvasInputSchema>;

type UpdateCanvasOutput = { ok: true };

export const update_canvas = defineTool<
  UpdateCanvasInput,
  UpdateCanvasOutput,
  SlackContext
>({
  name: "update_canvas",
  description:
    "Edit a canvas: insert/replace/delete sections by operation (user token, scope canvases:write).",
  inputSchema: updateCanvasInputSchema as unknown as z.ZodType<UpdateCanvasInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Edit canvas ${input.canvas_id} (${input.changes.length} change(s))`,
    });
    const changes = input.changes.map((c) => {
      const change: Record<string, unknown> = { operation: c.operation };
      if (c.section_id !== undefined) change.section_id = c.section_id;
      if (c.markdown !== undefined) {
        change.document_content = { type: "markdown", markdown: c.markdown };
      }
      return change;
    });
    await context.client.editCanvas({ canvas_id: input.canvas_id, changes });
    return { ok: true };
  },
});
