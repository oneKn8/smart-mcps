import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import {
  insertTableRequest,
  insertTextRequest,
  tableCellSlots,
  type DocsRequest,
} from "../request-builders.js";

// =============================================================================
// insert_table  (empty R x C grid; cells are filled separately)
// =============================================================================

const insertTableInputSchema = z.object({
  document_id: z.string().min(1),
  rows: z.number().int().min(1),
  columns: z.number().int().min(1),
  index: z.number().int().optional(),
  at_end: z.boolean().optional().default(false),
});

type InsertTableInput = z.input<typeof insertTableInputSchema>;
type InsertTableParsed = z.infer<typeof insertTableInputSchema>;
type InsertTableOutput = { document_id: string };

export const insertTableTool = defineTool<
  InsertTableInput,
  InsertTableOutput,
  DocsContext
>({
  name: "insert_table",
  description: "Insert an empty rows-by-columns table",
  // Cast required because `at_end` has `.optional().default(...)`.
  inputSchema: insertTableInputSchema as unknown as z.ZodType<InsertTableInput>,
  handler: async (input, ctx) => {
    const parsed = input as InsertTableParsed;
    if (!parsed.at_end && parsed.index === undefined) {
      throw new ValidationError(
        "insert_table needs `index` or `at_end: true`.",
      );
    }
    const req = parsed.at_end
      ? insertTableRequest({
          rows: parsed.rows,
          columns: parsed.columns,
          endOfSegment: true,
        })
      : insertTableRequest({
          rows: parsed.rows,
          columns: parsed.columns,
          index: parsed.index as number,
        });
    await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests: [req],
    });
    return { document_id: parsed.document_id };
  },
});

// =============================================================================
// fill_table  (get real cell indexes, then insertText per cell WRITE-BACKWARDS)
// =============================================================================

const fillTableInputSchema = z.object({
  document_id: z.string().min(1),
  cells: z.array(z.array(z.string())).min(1),
  table_index: z.number().int().min(0).optional().default(0),
});

type FillTableInput = z.input<typeof fillTableInputSchema>;
type FillTableParsed = z.infer<typeof fillTableInputSchema>;
type FillTableOutput = { document_id: string; cells_filled: number };

/**
 * Build the cell-fill requests for a real (post-insert) table. Each non-empty
 * cell's text is inserted at the cell's first-paragraph start index, emitted in
 * DESCENDING index order so each insert leaves the lower (earlier) cell indexes
 * valid — the "write backwards" rule applied to a single table.
 */
export function buildFillRequests(
  doc: unknown,
  tableIndex: number,
  cells: string[][],
): DocsRequest[] {
  const { rows, columns, slots } = tableCellSlots(doc, tableIndex);
  if (cells.length > rows) {
    throw new ValidationError(
      `cells has ${cells.length} rows but table #${tableIndex} has only ${rows}.`,
    );
  }
  const fills: { index: number; text: string }[] = [];
  cells.forEach((row, r) => {
    if (row.length > columns) {
      throw new ValidationError(
        `cells row ${r} has ${row.length} columns but table #${tableIndex} has only ${columns}.`,
      );
    }
    row.forEach((text, c) => {
      if (text.length === 0) return;
      const slot = slots.find((s) => s.row === r && s.column === c);
      if (slot) fills.push({ index: slot.index, text });
    });
  });
  fills.sort((a, b) => b.index - a.index); // write backwards
  return fills.map((f) =>
    insertTextRequest({ text: f.text, index: f.index }),
  );
}

export const fillTableTool = defineTool<
  FillTableInput,
  FillTableOutput,
  DocsContext
>({
  name: "fill_table",
  description: "Fill an existing table's cells with text",
  // Cast required because `table_index` has `.optional().default(...)`.
  inputSchema: fillTableInputSchema as unknown as z.ZodType<FillTableInput>,
  handler: async (input, ctx) => {
    const parsed = input as FillTableParsed;
    const doc = await ctx.client.getDocument({ documentId: parsed.document_id });
    const requests = buildFillRequests(doc, parsed.table_index, parsed.cells);
    if (requests.length === 0) {
      return { document_id: parsed.document_id, cells_filled: 0 };
    }
    await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests,
    });
    return { document_id: parsed.document_id, cells_filled: requests.length };
  },
});
