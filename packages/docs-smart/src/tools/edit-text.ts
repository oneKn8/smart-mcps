import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import {
  assertDeletableRange,
  assertNotTableStartIndex,
  assertValidInsertIndex,
  deleteContentRangeRequest,
  insertTextRequest,
  replaceAllTextRequest,
} from "../request-builders.js";

// =============================================================================
// insert_text  (explicit index; fetches the doc to reject table-start inserts)
// =============================================================================

const insertTextInputSchema = z.object({
  document_id: z.string().min(1),
  text: z.string().min(1),
  index: z.number().int(),
});

type InsertTextInput = z.infer<typeof insertTextInputSchema>;
type InsertTextOutput = { document_id: string };

export const insertTextTool = defineTool<
  InsertTextInput,
  InsertTextOutput,
  DocsContext
>({
  name: "insert_text",
  description: "Insert text at an index",
  inputSchema: insertTextInputSchema,
  handler: async (input, ctx) => {
    assertValidInsertIndex(input.index);
    // Fetch the doc so we can reject inserting at a table's start index (the
    // Docs API forbids it and would 400). Cheap safety for a write.
    const doc = await ctx.client.getDocument({ documentId: input.document_id });
    assertNotTableStartIndex(doc, input.index);
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [insertTextRequest({ text: input.text, index: input.index })],
    });
    return { document_id: input.document_id };
  },
});

// =============================================================================
// append_text  (end-of-segment; no index math, no get needed)
// =============================================================================

const appendTextInputSchema = z.object({
  document_id: z.string().min(1),
  text: z.string().min(1),
});

type AppendTextInput = z.infer<typeof appendTextInputSchema>;
type AppendTextOutput = { document_id: string };

export const appendTextTool = defineTool<
  AppendTextInput,
  AppendTextOutput,
  DocsContext
>({
  name: "append_text",
  description: "Append text to the document end",
  inputSchema: appendTextInputSchema,
  handler: async (input, ctx) => {
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [insertTextRequest({ text: input.text, endOfSegment: true })],
    });
    return { document_id: input.document_id };
  },
});

// =============================================================================
// delete_range  (fetches the doc to protect the body's final newline)
// =============================================================================

const deleteRangeInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
});

type DeleteRangeInput = z.infer<typeof deleteRangeInputSchema>;
type DeleteRangeOutput = { document_id: string };

export const deleteRangeTool = defineTool<
  DeleteRangeInput,
  DeleteRangeOutput,
  DocsContext
>({
  name: "delete_range",
  description: "Delete content over an index range",
  inputSchema: deleteRangeInputSchema,
  handler: async (input, ctx) => {
    const doc = await ctx.client.getDocument({ documentId: input.document_id });
    assertDeletableRange(doc, input.start_index, input.end_index);
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [
        deleteContentRangeRequest({
          startIndex: input.start_index,
          endIndex: input.end_index,
        }),
      ],
    });
    return { document_id: input.document_id };
  },
});

// =============================================================================
// replace_all_text  (templating; index-free; returns occurrencesChanged)
// =============================================================================

const replaceAllTextInputSchema = z.object({
  document_id: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  match_case: z.boolean().optional().default(true),
});

type ReplaceAllTextInput = z.input<typeof replaceAllTextInputSchema>;
type ReplaceAllTextParsed = z.infer<typeof replaceAllTextInputSchema>;
type ReplaceAllTextOutput = {
  document_id: string;
  occurrences_changed: number;
};

function readOccurrencesChanged(replies: unknown[] | undefined): number {
  const first = replies?.[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const block = (first as { replaceAllText?: unknown }).replaceAllText;
    if (block && typeof block === "object") {
      const n = (block as { occurrencesChanged?: unknown }).occurrencesChanged;
      if (typeof n === "number") return n;
    }
  }
  return 0;
}

export const replaceAllTextTool = defineTool<
  ReplaceAllTextInput,
  ReplaceAllTextOutput,
  DocsContext
>({
  name: "replace_all_text",
  description: "Replace all matching text in document",
  // Cast required because `match_case` has `.optional().default(...)`.
  inputSchema:
    replaceAllTextInputSchema as unknown as z.ZodType<ReplaceAllTextInput>,
  handler: async (input, ctx) => {
    const parsed = input as ReplaceAllTextParsed;
    const res = await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests: [
        replaceAllTextRequest({
          find: parsed.find,
          replace: parsed.replace,
          matchCase: parsed.match_case,
        }),
      ],
    });
    return {
      document_id: parsed.document_id,
      occurrences_changed: readOccurrencesChanged(res.replies),
    };
  },
});
