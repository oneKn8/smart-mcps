import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SheetsContext } from "../context.js";
import { parseSpreadsheetId } from "../sheet-ref.js";
import {
  mapDriveFile,
  mapSpreadsheetMeta,
  mapTabRef,
  userEnteredCellValue,
  type SlimFile,
  type SlimSpreadsheet,
} from "../mappers.js";
import { nullableString } from "../null-helpers.js";

/**
 * Escape a value for use inside a Drive `q` string literal: backslash first,
 * then single-quote (`'` -> `\'`, `\` -> `\\`), matching Drive's search-query
 * escaping rules.
 */
function escapeQ(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

// =============================================================================
// list_sheets
// =============================================================================

const listSheetsInputSchema = z.object({
  query: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional().default(100),
  page_token: z.string().optional(),
});

type ListSheetsInput = z.input<typeof listSheetsInputSchema>;
type ListSheetsParsed = z.infer<typeof listSheetsInputSchema>;

type ListSheetsOutput = {
  sheets: SlimFile[];
  next_page_token: string | null;
};

export const listSheetsTool = defineTool<
  ListSheetsInput,
  ListSheetsOutput,
  SheetsContext
>({
  name: "list_sheets",
  description: "List spreadsheets in Drive",
  inputSchema: listSheetsInputSchema as unknown as z.ZodType<ListSheetsInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListSheetsParsed;
    const q =
      `mimeType='${SPREADSHEET_MIME}' and trashed=false` +
      (parsed.query ? ` and name contains '${escapeQ(parsed.query)}'` : "");
    const res = await ctx.client.listFiles(q, {
      pageSize: parsed.page_size,
      ...(parsed.page_token !== undefined ? { pageToken: parsed.page_token } : {}),
      orderBy: "modifiedTime desc",
      fields: "nextPageToken,files(id,name,modifiedTime,webViewLink)",
    });
    return {
      sheets: res.files.map(mapDriveFile),
      next_page_token: res.nextPageToken ?? null,
    };
  },
});

// =============================================================================
// create_sheet
// =============================================================================

const seedSchema = z.object({
  tab: z.string().optional(),
  header: z.array(z.string()).optional(),
  rows: z.array(z.array(z.unknown())).optional(),
});

const createSheetInputSchema = z.object({
  title: z.string().min(1),
  folder_id: z.string().optional(),
  tabs: z.array(z.string().min(1)).optional(),
  seed: seedSchema.optional(),
});

type CreateSheetInput = z.input<typeof createSheetInputSchema>;
type CreateSheetParsed = z.infer<typeof createSheetInputSchema>;

type CreateSheetOutput = {
  spreadsheet_id: string | null;
  url: string | null;
  sheets: { sheet_id: number | null; title: string | null }[];
};

export const createSheetTool = defineTool<
  CreateSheetInput,
  CreateSheetOutput,
  SheetsContext
>({
  name: "create_sheet",
  description: "Create a spreadsheet",
  inputSchema: createSheetInputSchema as unknown as z.ZodType<CreateSheetInput>,
  handler: async (input, ctx) => {
    const parsed = input as CreateSheetParsed;
    const body: Record<string, unknown> = {
      properties: { title: parsed.title },
    };

    const sheetSpecs: unknown[] = [];
    if (parsed.tabs !== undefined) {
      for (const t of parsed.tabs) sheetSpecs.push({ properties: { title: t } });
    }
    if (parsed.seed !== undefined) {
      const seedRows: unknown[][] = [];
      if (parsed.seed.header !== undefined) seedRows.push(parsed.seed.header);
      if (parsed.seed.rows !== undefined) {
        for (const r of parsed.seed.rows) seedRows.push(r);
      }
      const seedSheet: Record<string, unknown> = {
        properties: { title: parsed.seed.tab ?? "Sheet1" },
      };
      if (seedRows.length > 0) {
        seedSheet.data = [
          {
            startRow: 0,
            startColumn: 0,
            rowData: seedRows.map((row) => ({
              values: row.map((cell) => ({
                userEnteredValue: userEnteredCellValue(cell),
              })),
            })),
          },
        ];
      }
      sheetSpecs.push(seedSheet);
    }
    if (sheetSpecs.length > 0) body.sheets = sheetSpecs;

    const created = await ctx.client.createSpreadsheet(body);
    const spreadsheetId = nullableString(created.spreadsheetId);

    if (parsed.folder_id !== undefined && spreadsheetId !== null) {
      await ctx.client.updateFile(spreadsheetId, {}, { addParents: parsed.folder_id });
    }

    return {
      spreadsheet_id: spreadsheetId,
      url: nullableString(created.spreadsheetUrl),
      sheets: (created.sheets ?? []).map(mapTabRef),
    };
  },
});

// =============================================================================
// get_sheet
// =============================================================================

const getSheetInputSchema = z.object({
  spreadsheet: z.string().min(1),
});

type GetSheetInput = z.input<typeof getSheetInputSchema>;
type GetSheetParsed = z.infer<typeof getSheetInputSchema>;

export const getSheetTool = defineTool<
  GetSheetInput,
  SlimSpreadsheet,
  SheetsContext
>({
  name: "get_sheet",
  description: "Get spreadsheet metadata and tabs",
  inputSchema: getSheetInputSchema as unknown as z.ZodType<GetSheetInput>,
  handler: async (input, ctx) => {
    const parsed = input as GetSheetParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const raw = await ctx.client.getSpreadsheet(id, {
      fields:
        "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties,namedRanges",
    });
    return mapSpreadsheetMeta(raw);
  },
});

// =============================================================================
// delete_sheet
// =============================================================================

const deleteSheetInputSchema = z.object({
  spreadsheet: z.string().min(1),
  permanent: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type DeleteSheetInput = z.input<typeof deleteSheetInputSchema>;
type DeleteSheetParsed = z.infer<typeof deleteSheetInputSchema>;

type DeleteSheetOutput = {
  trashed: boolean;
  deleted: boolean;
  spreadsheet_id: string;
};

export const deleteSheetTool = defineTool<
  DeleteSheetInput,
  DeleteSheetOutput,
  SheetsContext
>({
  name: "delete_sheet",
  description: "Trash or delete a spreadsheet",
  inputSchema: deleteSheetInputSchema as unknown as z.ZodType<DeleteSheetInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteSheetParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    guardDestructive({
      confirm: parsed.confirm,
      preview: `Delete spreadsheet ${id}${parsed.permanent ? " PERMANENTLY" : " (to trash)"}`,
    });
    if (parsed.permanent) {
      await ctx.client.deleteFile(id);
    } else {
      await ctx.client.trashFile(id);
    }
    return {
      trashed: !parsed.permanent,
      deleted: parsed.permanent,
      spreadsheet_id: id,
    };
  },
});
