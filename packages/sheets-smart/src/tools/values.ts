import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { SheetsContext } from "../context.js";
import { parseSpreadsheetId } from "../sheet-ref.js";

const valueInputOptionSchema = z
  .enum(["USER_ENTERED", "RAW"])
  .optional()
  .default("USER_ENTERED");

const rowsSchema = z.array(z.array(z.unknown()));

// =============================================================================
// read_range
// =============================================================================

const readRangeInputSchema = z.object({
  spreadsheet: z.string().min(1),
  range: z.string().min(1),
  value_render: z
    .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
    .optional()
    .default("FORMATTED_VALUE"),
  major_dimension: z.enum(["ROWS", "COLUMNS"]).optional().default("ROWS"),
});

type ReadRangeInput = z.input<typeof readRangeInputSchema>;
type ReadRangeParsed = z.infer<typeof readRangeInputSchema>;

type ReadRangeOutput = { range: string | null; values: unknown[][] };

export const readRangeTool = defineTool<
  ReadRangeInput,
  ReadRangeOutput,
  SheetsContext
>({
  name: "read_range",
  description: "Read cell values from a range",
  inputSchema: readRangeInputSchema as unknown as z.ZodType<ReadRangeInput>,
  handler: async (input, ctx) => {
    const parsed = input as ReadRangeParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const vr = await ctx.client.getValues(id, parsed.range, {
      valueRenderOption: parsed.value_render,
      majorDimension: parsed.major_dimension,
    });
    return { range: vr.range ?? null, values: vr.values ?? [] };
  },
});

// =============================================================================
// write_range
// =============================================================================

const writeRangeInputSchema = z.object({
  spreadsheet: z.string().min(1),
  range: z.string().min(1),
  values: rowsSchema,
  value_input_option: valueInputOptionSchema,
});

type WriteRangeInput = z.input<typeof writeRangeInputSchema>;
type WriteRangeParsed = z.infer<typeof writeRangeInputSchema>;

type WriteRangeOutput = {
  updated_range: string | null;
  updated_cells: number | null;
};

export const writeRangeTool = defineTool<
  WriteRangeInput,
  WriteRangeOutput,
  SheetsContext
>({
  name: "write_range",
  description: "Write values to a range",
  inputSchema: writeRangeInputSchema as unknown as z.ZodType<WriteRangeInput>,
  handler: async (input, ctx) => {
    const parsed = input as WriteRangeParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const res = await ctx.client.updateValues(
      id,
      parsed.range,
      parsed.values,
      parsed.value_input_option,
    );
    return {
      updated_range: res.updatedRange ?? null,
      updated_cells: res.updatedCells ?? null,
    };
  },
});

// =============================================================================
// append_rows
// =============================================================================

const appendRowsInputSchema = z.object({
  spreadsheet: z.string().min(1),
  range: z.string().min(1),
  values: rowsSchema,
  value_input_option: valueInputOptionSchema,
  insert_option: z
    .enum(["INSERT_ROWS", "OVERWRITE"])
    .optional()
    .default("INSERT_ROWS"),
});

type AppendRowsInput = z.input<typeof appendRowsInputSchema>;
type AppendRowsParsed = z.infer<typeof appendRowsInputSchema>;

type AppendRowsOutput = {
  updated_range: string | null;
  updated_rows: number | null;
};

export const appendRowsTool = defineTool<
  AppendRowsInput,
  AppendRowsOutput,
  SheetsContext
>({
  name: "append_rows",
  description: "Append rows after a table",
  inputSchema: appendRowsInputSchema as unknown as z.ZodType<AppendRowsInput>,
  handler: async (input, ctx) => {
    const parsed = input as AppendRowsParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const res = await ctx.client.appendValues(
      id,
      parsed.range,
      parsed.values,
      parsed.value_input_option,
      parsed.insert_option,
    );
    const updates = res.updates ?? {};
    return {
      updated_range: updates.updatedRange ?? null,
      updated_rows: updates.updatedRows ?? null,
    };
  },
});

// =============================================================================
// update_cells
// =============================================================================

const updateCellsInputSchema = z.object({
  spreadsheet: z.string().min(1),
  data: z
    .array(
      z.object({
        range: z.string().min(1),
        values: rowsSchema,
      }),
    )
    .min(1),
  value_input_option: valueInputOptionSchema,
});

type UpdateCellsInput = z.input<typeof updateCellsInputSchema>;
type UpdateCellsParsed = z.infer<typeof updateCellsInputSchema>;

type UpdateCellsOutput = { total_updated_cells: number };

export const updateCellsTool = defineTool<
  UpdateCellsInput,
  UpdateCellsOutput,
  SheetsContext
>({
  name: "update_cells",
  description: "Batch update multiple ranges",
  inputSchema: updateCellsInputSchema as unknown as z.ZodType<UpdateCellsInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateCellsParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const res = await ctx.client.batchUpdateValues(
      id,
      parsed.data,
      parsed.value_input_option,
    );
    return { total_updated_cells: res.totalUpdatedCells ?? 0 };
  },
});

// =============================================================================
// clear_range
// =============================================================================

const clearRangeInputSchema = z.object({
  spreadsheet: z.string().min(1),
  range: z.string().min(1),
});

type ClearRangeInput = z.input<typeof clearRangeInputSchema>;
type ClearRangeParsed = z.infer<typeof clearRangeInputSchema>;

type ClearRangeOutput = { cleared_range: string | null };

export const clearRangeTool = defineTool<
  ClearRangeInput,
  ClearRangeOutput,
  SheetsContext
>({
  name: "clear_range",
  description: "Clear values in a range",
  inputSchema: clearRangeInputSchema as unknown as z.ZodType<ClearRangeInput>,
  handler: async (input, ctx) => {
    const parsed = input as ClearRangeParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const res = await ctx.client.clearValues(id, parsed.range);
    return { cleared_range: res.clearedRange ?? null };
  },
});
