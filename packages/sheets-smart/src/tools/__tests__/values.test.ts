import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  readRangeTool,
  writeRangeTool,
  appendRowsTool,
  updateCellsTool,
  clearRangeTool,
} from "../values.js";

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// ---------------------------------------------------------------------------
// read_range
// ---------------------------------------------------------------------------

describe("readRangeTool", () => {
  it("metadata", () => {
    expect(readRangeTool.name).toBe("read_range");
    expect(readRangeTool.description.length).toBeLessThanOrEqual(60);
    expect(readRangeTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("calls getValues with defaults FORMATTED_VALUE / ROWS and shapes output", async () => {
    const client: FakeClient = {
      getValues: vi.fn().mockResolvedValue({
        range: "Sheet1!A1:B2",
        values: [["a", "b"]],
      }),
    };
    const parsed = readRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1!A1:B2",
    }) as Parameters<typeof readRangeTool.handler>[0];
    const out = await readRangeTool.handler(parsed, ctxOf(client));

    expect(client.getValues).toHaveBeenCalledWith("SID", "Sheet1!A1:B2", {
      valueRenderOption: "FORMATTED_VALUE",
      majorDimension: "ROWS",
    });
    expect(out).toEqual({ range: "Sheet1!A1:B2", values: [["a", "b"]] });
  });

  it("forwards value_render + major_dimension and defaults values to []", async () => {
    const client: FakeClient = {
      getValues: vi.fn().mockResolvedValue({ range: "Sheet1!A:A" }),
    };
    const parsed = readRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1!A:A",
      value_render: "UNFORMATTED_VALUE",
      major_dimension: "COLUMNS",
    }) as Parameters<typeof readRangeTool.handler>[0];
    const out = await readRangeTool.handler(parsed, ctxOf(client));

    expect(client.getValues).toHaveBeenCalledWith("SID", "Sheet1!A:A", {
      valueRenderOption: "UNFORMATTED_VALUE",
      majorDimension: "COLUMNS",
    });
    expect(out.values).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// write_range
// ---------------------------------------------------------------------------

describe("writeRangeTool", () => {
  it("metadata", () => {
    expect(writeRangeTool.name).toBe("write_range");
    expect(writeRangeTool.description.length).toBeLessThanOrEqual(60);
  });

  it("defaults value_input_option to USER_ENTERED and maps the response", async () => {
    const client: FakeClient = {
      updateValues: vi.fn().mockResolvedValue({
        updatedRange: "Sheet1!A1:B1",
        updatedCells: 2,
      }),
    };
    const parsed = writeRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1!A1:B1",
      values: [["x", "y"]],
    }) as Parameters<typeof writeRangeTool.handler>[0];
    const out = await writeRangeTool.handler(parsed, ctxOf(client));

    expect(client.updateValues).toHaveBeenCalledWith(
      "SID",
      "Sheet1!A1:B1",
      [["x", "y"]],
      "USER_ENTERED",
    );
    expect(out).toEqual({ updated_range: "Sheet1!A1:B1", updated_cells: 2 });
  });

  it("honors an explicit RAW value_input_option", async () => {
    const client: FakeClient = {
      updateValues: vi.fn().mockResolvedValue({}),
    };
    const parsed = writeRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1!A1",
      values: [["=A1"]],
      value_input_option: "RAW",
    }) as Parameters<typeof writeRangeTool.handler>[0];
    await writeRangeTool.handler(parsed, ctxOf(client));
    expect(client.updateValues.mock.calls[0]?.[3]).toBe("RAW");
  });
});

// ---------------------------------------------------------------------------
// append_rows
// ---------------------------------------------------------------------------

describe("appendRowsTool", () => {
  it("metadata", () => {
    expect(appendRowsTool.name).toBe("append_rows");
    expect(appendRowsTool.description.length).toBeLessThanOrEqual(60);
  });

  it("defaults USER_ENTERED + INSERT_ROWS and reads updates.* from the response", async () => {
    const client: FakeClient = {
      appendValues: vi.fn().mockResolvedValue({
        updates: { updatedRange: "Sheet1!A5:B5", updatedRows: 1 },
      }),
    };
    const parsed = appendRowsTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1",
      values: [["x", "y"]],
    }) as Parameters<typeof appendRowsTool.handler>[0];
    const out = await appendRowsTool.handler(parsed, ctxOf(client));

    expect(client.appendValues).toHaveBeenCalledWith(
      "SID",
      "Sheet1",
      [["x", "y"]],
      "USER_ENTERED",
      "INSERT_ROWS",
    );
    expect(out).toEqual({ updated_range: "Sheet1!A5:B5", updated_rows: 1 });
  });

  it("forwards an OVERWRITE insert_option", async () => {
    const client: FakeClient = {
      appendValues: vi.fn().mockResolvedValue({ updates: {} }),
    };
    const parsed = appendRowsTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1",
      values: [["x"]],
      insert_option: "OVERWRITE",
    }) as Parameters<typeof appendRowsTool.handler>[0];
    await appendRowsTool.handler(parsed, ctxOf(client));
    expect(client.appendValues.mock.calls[0]?.[4]).toBe("OVERWRITE");
  });
});

// ---------------------------------------------------------------------------
// update_cells
// ---------------------------------------------------------------------------

describe("updateCellsTool", () => {
  it("metadata", () => {
    expect(updateCellsTool.name).toBe("update_cells");
    expect(updateCellsTool.description.length).toBeLessThanOrEqual(60);
  });

  it("forwards data + value_input_option and returns total_updated_cells", async () => {
    const client: FakeClient = {
      batchUpdateValues: vi.fn().mockResolvedValue({ totalUpdatedCells: 5 }),
    };
    const parsed = updateCellsTool.inputSchema.parse({
      spreadsheet: "SID",
      data: [
        { range: "Sheet1!A1", values: [["a"]] },
        { range: "Sheet1!B1", values: [["b"]] },
      ],
    }) as Parameters<typeof updateCellsTool.handler>[0];
    const out = await updateCellsTool.handler(parsed, ctxOf(client));

    expect(client.batchUpdateValues).toHaveBeenCalledWith(
      "SID",
      [
        { range: "Sheet1!A1", values: [["a"]] },
        { range: "Sheet1!B1", values: [["b"]] },
      ],
      "USER_ENTERED",
    );
    expect(out).toEqual({ total_updated_cells: 5 });
  });

  it("rejects an empty data array", () => {
    expect(() =>
      updateCellsTool.inputSchema.parse({ spreadsheet: "SID", data: [] }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// clear_range
// ---------------------------------------------------------------------------

describe("clearRangeTool", () => {
  it("metadata", () => {
    expect(clearRangeTool.name).toBe("clear_range");
    expect(clearRangeTool.description.length).toBeLessThanOrEqual(60);
  });

  it("calls clearValues and returns the cleared range", async () => {
    const client: FakeClient = {
      clearValues: vi.fn().mockResolvedValue({ clearedRange: "Sheet1!A1:B2" }),
    };
    const parsed = clearRangeTool.inputSchema.parse({
      spreadsheet: "SID",
      range: "Sheet1!A1:B2",
    }) as Parameters<typeof clearRangeTool.handler>[0];
    const out = await clearRangeTool.handler(parsed, ctxOf(client));

    expect(client.clearValues).toHaveBeenCalledWith("SID", "Sheet1!A1:B2");
    expect(out).toEqual({ cleared_range: "Sheet1!A1:B2" });
  });
});
