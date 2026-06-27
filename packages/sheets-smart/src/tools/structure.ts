import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { SheetsContext } from "../context.js";
import type {
  SheetsClient,
  BatchUpdateSpreadsheetResponse,
} from "../client.js";
import { parseSpreadsheetId } from "../sheet-ref.js";
import { mapTabRef } from "../mappers.js";

/**
 * Single plumbing path for every structural/format request. `add_tab`,
 * `rename_tab`, `delete_tab`, `format_range`, and the raw `batch_update`
 * escape hatch all emit `Request[]` objects into this. Future request builders
 * (conditional formats, charts, data validation) bolt on here with no new
 * transport code.
 */
async function runBatch(
  client: SheetsClient,
  id: string,
  requests: unknown[],
): Promise<BatchUpdateSpreadsheetResponse> {
  return client.batchUpdate(id, requests);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// =============================================================================
// add_tab
// =============================================================================

const addTabInputSchema = z.object({
  spreadsheet: z.string().min(1),
  title: z.string().min(1),
  rows: z.number().int().min(1).optional().default(1000),
  cols: z.number().int().min(1).optional().default(26),
});

type AddTabInput = z.input<typeof addTabInputSchema>;
type AddTabParsed = z.infer<typeof addTabInputSchema>;

type AddTabOutput = { sheet_id: number | null; title: string };

export const addTabTool = defineTool<AddTabInput, AddTabOutput, SheetsContext>({
  name: "add_tab",
  description: "Add a tab to a spreadsheet",
  inputSchema: addTabInputSchema as unknown as z.ZodType<AddTabInput>,
  handler: async (input, ctx) => {
    const parsed = input as AddTabParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const res = await runBatch(ctx.client, id, [
      {
        addSheet: {
          properties: {
            title: parsed.title,
            gridProperties: { rowCount: parsed.rows, columnCount: parsed.cols },
          },
        },
      },
    ]);
    const reply = asObject(res.replies?.[0]);
    const ref = mapTabRef(asObject(reply.addSheet));
    return { sheet_id: ref.sheet_id, title: parsed.title };
  },
});

// =============================================================================
// rename_tab
// =============================================================================

const renameTabInputSchema = z.object({
  spreadsheet: z.string().min(1),
  sheet_id: z.number().int(),
  title: z.string().min(1),
});

type RenameTabInput = z.input<typeof renameTabInputSchema>;
type RenameTabParsed = z.infer<typeof renameTabInputSchema>;

type RenameTabOutput = { sheet_id: number; title: string };

export const renameTabTool = defineTool<
  RenameTabInput,
  RenameTabOutput,
  SheetsContext
>({
  name: "rename_tab",
  description: "Rename a tab",
  inputSchema: renameTabInputSchema as unknown as z.ZodType<RenameTabInput>,
  handler: async (input, ctx) => {
    const parsed = input as RenameTabParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    await runBatch(ctx.client, id, [
      {
        updateSheetProperties: {
          properties: { sheetId: parsed.sheet_id, title: parsed.title },
          fields: "title",
        },
      },
    ]);
    return { sheet_id: parsed.sheet_id, title: parsed.title };
  },
});

// =============================================================================
// delete_tab
// =============================================================================

const deleteTabInputSchema = z.object({
  spreadsheet: z.string().min(1),
  sheet_id: z.number().int(),
  confirm: z.boolean().optional().default(false),
});

type DeleteTabInput = z.input<typeof deleteTabInputSchema>;
type DeleteTabParsed = z.infer<typeof deleteTabInputSchema>;

type DeleteTabOutput = { deleted_sheet_id: number };

export const deleteTabTool = defineTool<
  DeleteTabInput,
  DeleteTabOutput,
  SheetsContext
>({
  name: "delete_tab",
  description: "Delete a tab",
  inputSchema: deleteTabInputSchema as unknown as z.ZodType<DeleteTabInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteTabParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    guardDestructive({
      confirm: parsed.confirm,
      preview: `Delete tab ${parsed.sheet_id} from ${id}`,
    });
    await runBatch(ctx.client, id, [{ deleteSheet: { sheetId: parsed.sheet_id } }]);
    return { deleted_sheet_id: parsed.sheet_id };
  },
});

// =============================================================================
// format_range
// =============================================================================

const numberFormatSchema = z.object({
  type: z.string().min(1),
  pattern: z.string().optional(),
});

const colorSchema = z.object({
  red: z.number().min(0).max(1),
  green: z.number().min(0).max(1),
  blue: z.number().min(0).max(1),
  alpha: z.number().min(0).max(1).optional(),
});

const formatRangeInputSchema = z.object({
  spreadsheet: z.string().min(1),
  sheet_id: z.number().int(),
  start_row: z.number().int().min(0),
  end_row: z.number().int().min(0),
  start_col: z.number().int().min(0),
  end_col: z.number().int().min(0),
  bold: z.boolean().optional(),
  number_format: numberFormatSchema.optional(),
  background: colorSchema.optional(),
  freeze_rows: z.number().int().min(0).optional(),
});

type FormatRangeInput = z.input<typeof formatRangeInputSchema>;
type FormatRangeParsed = z.infer<typeof formatRangeInputSchema>;

type FormatRangeOutput = { applied: boolean };

export const formatRangeTool = defineTool<
  FormatRangeInput,
  FormatRangeOutput,
  SheetsContext
>({
  name: "format_range",
  description: "Format cells in a range",
  inputSchema: formatRangeInputSchema as unknown as z.ZodType<FormatRangeInput>,
  handler: async (input, ctx) => {
    const parsed = input as FormatRangeParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);

    const requests: unknown[] = [];
    const cellFormat: Record<string, unknown> = {};
    const fields: string[] = [];

    if (parsed.bold !== undefined) {
      cellFormat.textFormat = { bold: parsed.bold };
      fields.push("userEnteredFormat.textFormat.bold");
    }
    if (parsed.number_format !== undefined) {
      cellFormat.numberFormat = {
        type: parsed.number_format.type,
        ...(parsed.number_format.pattern !== undefined
          ? { pattern: parsed.number_format.pattern }
          : {}),
      };
      fields.push("userEnteredFormat.numberFormat");
    }
    if (parsed.background !== undefined) {
      cellFormat.backgroundColor = parsed.background;
      fields.push("userEnteredFormat.backgroundColor");
    }

    if (fields.length > 0) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: parsed.sheet_id,
            startRowIndex: parsed.start_row,
            endRowIndex: parsed.end_row,
            startColumnIndex: parsed.start_col,
            endColumnIndex: parsed.end_col,
          },
          cell: { userEnteredFormat: cellFormat },
          fields: fields.join(","),
        },
      });
    }

    if (parsed.freeze_rows !== undefined) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: parsed.sheet_id,
            gridProperties: { frozenRowCount: parsed.freeze_rows },
          },
          fields: "gridProperties.frozenRowCount",
        },
      });
    }

    if (requests.length === 0) {
      throw new ValidationError(
        "format_range: provide at least one of bold, number_format, background, freeze_rows",
      );
    }

    await runBatch(ctx.client, id, requests);
    return { applied: true };
  },
});

// =============================================================================
// batch_update (raw escape hatch)
// =============================================================================

const batchUpdateInputSchema = z.object({
  spreadsheet: z.string().min(1),
  requests: z.array(z.unknown()),
});

type BatchUpdateInput = z.input<typeof batchUpdateInputSchema>;
type BatchUpdateParsed = z.infer<typeof batchUpdateInputSchema>;

type BatchUpdateOutput = { replies: unknown[] };

export const batchUpdateTool = defineTool<
  BatchUpdateInput,
  BatchUpdateOutput,
  SheetsContext
>({
  name: "batch_update",
  description: "Run raw batchUpdate requests",
  inputSchema: batchUpdateInputSchema as unknown as z.ZodType<BatchUpdateInput>,
  handler: async (input, ctx) => {
    const parsed = input as BatchUpdateParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    if (!Array.isArray(parsed.requests) || parsed.requests.length === 0) {
      throw new ValidationError(
        "batch_update: requests must be a non-empty array of request objects",
      );
    }
    for (const r of parsed.requests) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new ValidationError(
          "batch_update: each request must be a JSON object",
        );
      }
    }
    const res = await runBatch(ctx.client, id, parsed.requests);
    return { replies: res.replies ?? [] };
  },
});
