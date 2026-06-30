import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import {
  insertInlineImageRequest,
  insertPageBreakRequest,
} from "../request-builders.js";

// =============================================================================
// insert_image  (inline image from a public URI; optional size in points)
// =============================================================================

const insertImageInputSchema = z.object({
  document_id: z.string().min(1),
  uri: z.string().min(1),
  index: z.number().int().optional(),
  at_end: z.boolean().optional().default(false),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

type InsertImageInput = z.input<typeof insertImageInputSchema>;
type InsertImageParsed = z.infer<typeof insertImageInputSchema>;
type InsertImageOutput = { document_id: string };

export const insertImageTool = defineTool<
  InsertImageInput,
  InsertImageOutput,
  DocsContext
>({
  name: "insert_image",
  description: "Insert an inline image from a URI",
  // Cast required because `at_end` has `.optional().default(...)`.
  inputSchema: insertImageInputSchema as unknown as z.ZodType<InsertImageInput>,
  handler: async (input, ctx) => {
    const parsed = input as InsertImageParsed;
    if (!parsed.at_end && parsed.index === undefined) {
      throw new ValidationError(
        "insert_image needs `index` or `at_end: true`.",
      );
    }
    const req = parsed.at_end
      ? insertInlineImageRequest({
          uri: parsed.uri,
          endOfSegment: true,
          ...(parsed.width !== undefined ? { width: parsed.width } : {}),
          ...(parsed.height !== undefined ? { height: parsed.height } : {}),
        })
      : insertInlineImageRequest({
          uri: parsed.uri,
          index: parsed.index as number,
          ...(parsed.width !== undefined ? { width: parsed.width } : {}),
          ...(parsed.height !== undefined ? { height: parsed.height } : {}),
        });
    await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests: [req],
    });
    return { document_id: parsed.document_id };
  },
});

// =============================================================================
// insert_page_break
// =============================================================================

const insertPageBreakInputSchema = z.object({
  document_id: z.string().min(1),
  index: z.number().int().optional(),
  at_end: z.boolean().optional().default(false),
});

type InsertPageBreakInput = z.input<typeof insertPageBreakInputSchema>;
type InsertPageBreakParsed = z.infer<typeof insertPageBreakInputSchema>;
type InsertPageBreakOutput = { document_id: string };

export const insertPageBreakTool = defineTool<
  InsertPageBreakInput,
  InsertPageBreakOutput,
  DocsContext
>({
  name: "insert_page_break",
  description: "Insert a page break",
  // Cast required because `at_end` has `.optional().default(...)`.
  inputSchema:
    insertPageBreakInputSchema as unknown as z.ZodType<InsertPageBreakInput>,
  handler: async (input, ctx) => {
    const parsed = input as InsertPageBreakParsed;
    if (!parsed.at_end && parsed.index === undefined) {
      throw new ValidationError(
        "insert_page_break needs `index` or `at_end: true`.",
      );
    }
    const req = parsed.at_end
      ? insertPageBreakRequest({ endOfSegment: true })
      : insertPageBreakRequest({ index: parsed.index as number });
    await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests: [req],
    });
    return { document_id: parsed.document_id };
  },
});
