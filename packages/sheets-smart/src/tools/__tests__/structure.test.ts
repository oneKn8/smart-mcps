import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  addTabTool,
  renameTabTool,
  deleteTabTool,
  formatRangeTool,
  batchUpdateTool,
} from "../structure.js";

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

function batchClient(reply: unknown = {}): FakeClient {
  return {
    batchUpdate: vi.fn().mockResolvedValue({ replies: [reply] }),
  };
}

// ---------------------------------------------------------------------------
// add_tab
// ---------------------------------------------------------------------------

describe("addTabTool", () => {
  it("metadata", () => {
    expect(addTabTool.name).toBe("add_tab");
    expect(addTabTool.description.length).toBeLessThanOrEqual(60);
    expect(addTabTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("emits addSheet with default rows/cols and returns the new sheet_id", async () => {
    const client = batchClient({
      addSheet: { properties: { sheetId: 42, title: "Q3" } },
    });
    const parsed = addTabTool.inputSchema.parse({
      spreadsheet: "SID",
      title: "Q3",
    }) as Parameters<typeof addTabTool.handler>[0];
    const out = await addTabTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdate).toHaveBeenCalledWith("SID", [
      {
        addSheet: {
          properties: {
            title: "Q3",
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
      },
    ]);
    expect(out).toEqual({ sheet_id: 42, title: "Q3" });
  });

  it("honors custom rows/cols", async () => {
    const client = batchClient({ addSheet: { properties: { sheetId: 1 } } });
    const parsed = addTabTool.inputSchema.parse({
      spreadsheet: "SID",
      title: "Big",
      rows: 5,
      cols: 3,
    }) as Parameters<typeof addTabTool.handler>[0];
    await addTabTool.handler(parsed, ctxOf(client));
    const req = client.batchUpdate.mock.calls[0]?.[1] as Array<{
      addSheet: { properties: { gridProperties: unknown } };
    }>;
    expect(req[0]?.addSheet.properties.gridProperties).toEqual({
      rowCount: 5,
      columnCount: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// rename_tab
// ---------------------------------------------------------------------------

describe("renameTabTool", () => {
  it("metadata", () => {
    expect(renameTabTool.name).toBe("rename_tab");
    expect(renameTabTool.description.length).toBeLessThanOrEqual(60);
  });

  it("emits updateSheetProperties with a precise fields mask", async () => {
    const client = batchClient();
    const parsed = renameTabTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 7,
      title: "Renamed",
    }) as Parameters<typeof renameTabTool.handler>[0];
    const out = await renameTabTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdate).toHaveBeenCalledWith("SID", [
      {
        updateSheetProperties: {
          properties: { sheetId: 7, title: "Renamed" },
          fields: "title",
        },
      },
    ]);
    expect(out).toEqual({ sheet_id: 7, title: "Renamed" });
  });
});

// ---------------------------------------------------------------------------
// delete_tab
// ---------------------------------------------------------------------------

describe("deleteTabTool", () => {
  it("metadata", () => {
    expect(deleteTabTool.name).toBe("delete_tab");
    expect(deleteTabTool.description.length).toBeLessThanOrEqual(60);
  });

  it("requires confirm: true (ConfirmRequiredError) and does not call batchUpdate", async () => {
    const client = batchClient();
    const parsed = deleteTabTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 3,
    }) as Parameters<typeof deleteTabTool.handler>[0];
    await expect(
      deleteTabTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("emits deleteSheet when confirmed", async () => {
    const client = batchClient();
    const parsed = deleteTabTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 3,
      confirm: true,
    }) as Parameters<typeof deleteTabTool.handler>[0];
    const out = await deleteTabTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdate).toHaveBeenCalledWith("SID", [
      { deleteSheet: { sheetId: 3 } },
    ]);
    expect(out).toEqual({ deleted_sheet_id: 3 });
  });
});

// ---------------------------------------------------------------------------
// format_range
// ---------------------------------------------------------------------------

describe("formatRangeTool", () => {
  it("metadata", () => {
    expect(formatRangeTool.name).toBe("format_range");
    expect(formatRangeTool.description.length).toBeLessThanOrEqual(60);
  });

  it("composes repeatCell (bold + number format + background) with a precise fields mask", async () => {
    const client = batchClient();
    const parsed = formatRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 0,
      start_row: 0,
      end_row: 1,
      start_col: 0,
      end_col: 4,
      bold: true,
      number_format: { type: "CURRENCY", pattern: "$#,##0.00" },
      background: { red: 0.9, green: 0.9, blue: 0.9 },
    }) as Parameters<typeof formatRangeTool.handler>[0];
    const out = await formatRangeTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdate).toHaveBeenCalledWith("SID", [
      {
        repeatCell: {
          range: {
            sheetId: 0,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 4,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
            },
          },
          fields:
            "userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat,userEnteredFormat.backgroundColor",
        },
      },
    ]);
    expect(out).toEqual({ applied: true });
  });

  it("emits an updateSheetProperties freeze request when freeze_rows is set", async () => {
    const client = batchClient();
    const parsed = formatRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 0,
      start_row: 0,
      end_row: 1,
      start_col: 0,
      end_col: 1,
      bold: true,
      freeze_rows: 1,
    }) as Parameters<typeof formatRangeTool.handler>[0];
    await formatRangeTool.handler(parsed, ctxOf(client));

    const requests = client.batchUpdate.mock.calls[0]?.[1] as unknown[];
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      updateSheetProperties: {
        properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    });
  });

  it("throws ValidationError when no formatting option is supplied", async () => {
    const client = batchClient();
    const parsed = formatRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      sheet_id: 0,
      start_row: 0,
      end_row: 1,
      start_col: 0,
      end_col: 1,
    }) as Parameters<typeof formatRangeTool.handler>[0];
    await expect(
      formatRangeTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// batch_update (raw escape hatch)
// ---------------------------------------------------------------------------

describe("batchUpdateTool", () => {
  it("metadata", () => {
    expect(batchUpdateTool.name).toBe("batch_update");
    expect(batchUpdateTool.description.length).toBeLessThanOrEqual(60);
  });

  it("forwards a raw requests array and returns replies", async () => {
    const client: FakeClient = {
      batchUpdate: vi.fn().mockResolvedValue({ replies: [{ a: 1 }] }),
    };
    const parsed = batchUpdateTool.inputSchema.parse({
      spreadsheet: "SID",
      requests: [{ addSheet: { properties: { title: "T" } } }],
    }) as Parameters<typeof batchUpdateTool.handler>[0];
    const out = await batchUpdateTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdate).toHaveBeenCalledWith("SID", [
      { addSheet: { properties: { title: "T" } } },
    ]);
    expect(out).toEqual({ replies: [{ a: 1 }] });
  });

  it("throws ValidationError on an empty requests array", async () => {
    const client: FakeClient = { batchUpdate: vi.fn() };
    const parsed = batchUpdateTool.inputSchema.parse({
      spreadsheet: "SID",
      requests: [],
    }) as Parameters<typeof batchUpdateTool.handler>[0];
    await expect(
      batchUpdateTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationError when a request element is not an object", async () => {
    const client: FakeClient = { batchUpdate: vi.fn() };
    const parsed = batchUpdateTool.inputSchema.parse({
      spreadsheet: "SID",
      requests: [123],
    }) as Parameters<typeof batchUpdateTool.handler>[0];
    await expect(
      batchUpdateTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });
});
