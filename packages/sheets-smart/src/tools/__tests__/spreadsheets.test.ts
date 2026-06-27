import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  listSheetsTool,
  createSheetTool,
  getSheetTool,
  deleteSheetTool,
} from "../spreadsheets.js";

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// ---------------------------------------------------------------------------
// list_sheets
// ---------------------------------------------------------------------------

describe("listSheetsTool", () => {
  it("has the right name and a short description", () => {
    expect(listSheetsTool.name).toBe("list_sheets");
    expect(listSheetsTool.description.length).toBeLessThanOrEqual(60);
    expect(listSheetsTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("builds the base q + fields + orderBy and maps files", async () => {
    const client: FakeClient = {
      listFiles: vi.fn().mockResolvedValue({
        files: [
          {
            id: "f1",
            name: "Ledger",
            modifiedTime: "2026-06-27T00:00:00Z",
            webViewLink: "https://x/f1",
          },
        ],
        nextPageToken: "tok",
      }),
    };
    const parsed = listSheetsTool.inputSchema.parse({}) as Parameters<
      typeof listSheetsTool.handler
    >[0];
    const out = await listSheetsTool.handler(parsed, ctxOf(client));

    expect(client.listFiles).toHaveBeenCalledWith(
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      {
        pageSize: 100,
        orderBy: "modifiedTime desc",
        fields: "nextPageToken,files(id,name,modifiedTime,webViewLink)",
      },
    );
    expect(out.sheets).toEqual([
      {
        id: "f1",
        name: "Ledger",
        modified_time: "2026-06-27T00:00:00Z",
        url: "https://x/f1",
      },
    ]);
    expect(out.next_page_token).toBe("tok");
  });

  it("appends an escaped name-contains clause and forwards page_token", async () => {
    const client: FakeClient = {
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    };
    const parsed = listSheetsTool.inputSchema.parse({
      query: "Bob's \\ Sheet",
      page_size: 25,
      page_token: "pt",
    }) as Parameters<typeof listSheetsTool.handler>[0];
    await listSheetsTool.handler(parsed, ctxOf(client));

    const call = client.listFiles.mock.calls[0];
    expect(call?.[0]).toBe(
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false" +
        " and name contains 'Bob\\'s \\\\ Sheet'",
    );
    expect(call?.[1]).toMatchObject({ pageSize: 25, pageToken: "pt" });
  });

  it("returns next_page_token null when absent", async () => {
    const client: FakeClient = {
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    };
    const parsed = listSheetsTool.inputSchema.parse({}) as Parameters<
      typeof listSheetsTool.handler
    >[0];
    const out = await listSheetsTool.handler(parsed, ctxOf(client));
    expect(out.next_page_token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create_sheet
// ---------------------------------------------------------------------------

describe("createSheetTool", () => {
  it("has the right name and short description", () => {
    expect(createSheetTool.name).toBe("create_sheet");
    expect(createSheetTool.description.length).toBeLessThanOrEqual(60);
  });

  it("requires a title", () => {
    expect(() => createSheetTool.inputSchema.parse({})).toThrow();
  });

  it("creates with just a title and maps the returned sheets", async () => {
    const client: FakeClient = {
      createSpreadsheet: vi.fn().mockResolvedValue({
        spreadsheetId: "SID",
        spreadsheetUrl: "https://docs/SID",
        sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }],
      }),
    };
    const parsed = createSheetTool.inputSchema.parse({
      title: "Budget",
    }) as Parameters<typeof createSheetTool.handler>[0];
    const out = await createSheetTool.handler(parsed, ctxOf(client));

    expect(client.createSpreadsheet).toHaveBeenCalledWith({
      properties: { title: "Budget" },
    });
    expect(out).toEqual({
      spreadsheet_id: "SID",
      url: "https://docs/SID",
      sheets: [{ sheet_id: 0, title: "Sheet1" }],
    });
  });

  it("builds tabs and a seed sheet with header + rows, detecting formula/number/string", async () => {
    const client: FakeClient = {
      createSpreadsheet: vi.fn().mockResolvedValue({
        spreadsheetId: "SID",
        spreadsheetUrl: "u",
        sheets: [],
      }),
    };
    const parsed = createSheetTool.inputSchema.parse({
      title: "Ledger",
      tabs: ["Summary"],
      seed: {
        tab: "Payments",
        header: ["Date", "Amount"],
        rows: [["2026-06-01", 100, "=B2*2", true]],
      },
    }) as Parameters<typeof createSheetTool.handler>[0];
    await createSheetTool.handler(parsed, ctxOf(client));

    const body = client.createSpreadsheet.mock.calls[0]?.[0] as {
      sheets: unknown[];
    };
    expect(body.sheets[0]).toEqual({ properties: { title: "Summary" } });
    expect(body.sheets[1]).toEqual({
      properties: { title: "Payments" },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData: [
            {
              values: [
                { userEnteredValue: { stringValue: "Date" } },
                { userEnteredValue: { stringValue: "Amount" } },
              ],
            },
            {
              values: [
                { userEnteredValue: { stringValue: "2026-06-01" } },
                { userEnteredValue: { numberValue: 100 } },
                { userEnteredValue: { formulaValue: "=B2*2" } },
                { userEnteredValue: { boolValue: true } },
              ],
            },
          ],
        },
      ],
    });
  });

  it("moves the new sheet into folder_id via updateFile addParents", async () => {
    const client: FakeClient = {
      createSpreadsheet: vi.fn().mockResolvedValue({
        spreadsheetId: "SID",
        spreadsheetUrl: "u",
        sheets: [],
      }),
      updateFile: vi.fn().mockResolvedValue({ id: "SID" }),
    };
    const parsed = createSheetTool.inputSchema.parse({
      title: "X",
      folder_id: "folderA",
    }) as Parameters<typeof createSheetTool.handler>[0];
    await createSheetTool.handler(parsed, ctxOf(client));

    expect(client.updateFile).toHaveBeenCalledWith(
      "SID",
      {},
      { addParents: "folderA" },
    );
  });
});

// ---------------------------------------------------------------------------
// get_sheet
// ---------------------------------------------------------------------------

describe("getSheetTool", () => {
  it("has the right name", () => {
    expect(getSheetTool.name).toBe("get_sheet");
  });

  it("parses a URL ref, requests the fields mask, and maps metadata", async () => {
    const client: FakeClient = {
      getSpreadsheet: vi.fn().mockResolvedValue({
        spreadsheetId: "SID",
        spreadsheetUrl: "https://docs/SID",
        properties: { title: "Ledger" },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Payments",
              gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 },
            },
          },
        ],
        namedRanges: [{ name: "total" }],
      }),
    };
    const parsed = getSheetTool.inputSchema.parse({
      spreadsheet: "https://docs.google.com/spreadsheets/d/SID/edit#gid=0",
    }) as Parameters<typeof getSheetTool.handler>[0];
    const out = await getSheetTool.handler(parsed, ctxOf(client));

    expect(client.getSpreadsheet).toHaveBeenCalledWith("SID", {
      fields:
        "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties,namedRanges",
    });
    expect(out).toEqual({
      title: "Ledger",
      url: "https://docs/SID",
      tabs: [
        {
          sheet_id: 0,
          title: "Payments",
          rows: 1000,
          cols: 26,
          frozen_rows: 1,
        },
      ],
      named_ranges: [{ name: "total" }],
    });
  });

  it("throws ValidationError on a junk spreadsheet ref", async () => {
    const client: FakeClient = { getSpreadsheet: vi.fn() };
    const parsed = getSheetTool.inputSchema.parse({
      spreadsheet: "not a ref",
    }) as Parameters<typeof getSheetTool.handler>[0];
    await expect(getSheetTool.handler(parsed, ctxOf(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(client.getSpreadsheet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// delete_sheet
// ---------------------------------------------------------------------------

describe("deleteSheetTool", () => {
  it("has the right name", () => {
    expect(deleteSheetTool.name).toBe("delete_sheet");
  });

  it("requires confirm: true (ConfirmRequiredError otherwise) and does not call the client", async () => {
    const client: FakeClient = { trashFile: vi.fn(), deleteFile: vi.fn() };
    const parsed = deleteSheetTool.inputSchema.parse({
      spreadsheet: "SID",
    }) as Parameters<typeof deleteSheetTool.handler>[0];
    await expect(
      deleteSheetTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.trashFile).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it("trashes by default when confirmed", async () => {
    const client: FakeClient = {
      trashFile: vi.fn().mockResolvedValue({ id: "SID", trashed: true }),
      deleteFile: vi.fn(),
    };
    const parsed = deleteSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      confirm: true,
    }) as Parameters<typeof deleteSheetTool.handler>[0];
    const out = await deleteSheetTool.handler(parsed, ctxOf(client));

    expect(client.trashFile).toHaveBeenCalledWith("SID");
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(out).toEqual({ trashed: true, deleted: false, spreadsheet_id: "SID" });
  });

  it("permanently deletes when permanent + confirm", async () => {
    const client: FakeClient = {
      trashFile: vi.fn(),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };
    const parsed = deleteSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      permanent: true,
      confirm: true,
    }) as Parameters<typeof deleteSheetTool.handler>[0];
    const out = await deleteSheetTool.handler(parsed, ctxOf(client));

    expect(client.deleteFile).toHaveBeenCalledWith("SID");
    expect(client.trashFile).not.toHaveBeenCalled();
    expect(out).toEqual({ trashed: false, deleted: true, spreadsheet_id: "SID" });
  });
});
