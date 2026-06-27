import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import { shareSheetTool, quickAddRowTool } from "../sharing.js";

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// ---------------------------------------------------------------------------
// share_sheet
// ---------------------------------------------------------------------------

describe("shareSheetTool", () => {
  it("metadata", () => {
    expect(shareSheetTool.name).toBe("share_sheet");
    expect(shareSheetTool.description.length).toBeLessThanOrEqual(60);
    expect(shareSheetTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("requires confirm: true (ConfirmRequiredError) and does not call the client", async () => {
    const client: FakeClient = {
      createPermission: vi.fn(),
      getWebViewLink: vi.fn(),
    };
    const parsed = shareSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      role: "writer",
      type: "user",
      email: "bob@example.test",
    }) as Parameters<typeof shareSheetTool.handler>[0];
    await expect(
      shareSheetTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createPermission).not.toHaveBeenCalled();
  });

  it("rejects type=user without an email before confirm gate", async () => {
    const client: FakeClient = {
      createPermission: vi.fn(),
      getWebViewLink: vi.fn(),
    };
    const parsed = shareSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      role: "writer",
      type: "user",
      confirm: true,
    }) as Parameters<typeof shareSheetTool.handler>[0];
    await expect(
      shareSheetTool.handler(parsed, ctxOf(client)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createPermission).not.toHaveBeenCalled();
  });

  it("creates a user permission and returns id + web_view_link when confirmed", async () => {
    const client: FakeClient = {
      createPermission: vi.fn().mockResolvedValue({ id: "perm1" }),
      getWebViewLink: vi.fn().mockResolvedValue("https://docs/SID"),
    };
    const parsed = shareSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      role: "writer",
      type: "user",
      email: "bob@example.test",
      confirm: true,
    }) as Parameters<typeof shareSheetTool.handler>[0];
    const out = await shareSheetTool.handler(parsed, ctxOf(client));

    expect(client.createPermission).toHaveBeenCalledWith(
      "SID",
      { role: "writer", type: "user", emailAddress: "bob@example.test" },
      { sendNotificationEmail: true },
    );
    expect(client.getWebViewLink).toHaveBeenCalledWith("SID");
    expect(out).toEqual({
      permission_id: "perm1",
      web_view_link: "https://docs/SID",
    });
  });

  it("shares anyone-with-link without emailAddress and honors notify=false", async () => {
    const client: FakeClient = {
      createPermission: vi.fn().mockResolvedValue({ id: "perm2" }),
      getWebViewLink: vi.fn().mockResolvedValue("link"),
    };
    const parsed = shareSheetTool.inputSchema.parse({
      spreadsheet: "SID",
      role: "reader",
      type: "anyone",
      notify: false,
      confirm: true,
    }) as Parameters<typeof shareSheetTool.handler>[0];
    await shareSheetTool.handler(parsed, ctxOf(client));

    expect(client.createPermission).toHaveBeenCalledWith(
      "SID",
      { role: "reader", type: "anyone" },
      { sendNotificationEmail: false },
    );
  });
});

// ---------------------------------------------------------------------------
// quick_add_row
// ---------------------------------------------------------------------------

describe("quickAddRowTool", () => {
  it("metadata", () => {
    expect(quickAddRowTool.name).toBe("quick_add_row");
    expect(quickAddRowTool.description.length).toBeLessThanOrEqual(60);
  });

  it("appends a single row to A1 by default (USER_ENTERED / INSERT_ROWS)", async () => {
    const client: FakeClient = {
      appendValues: vi.fn().mockResolvedValue({
        updates: { updatedRange: "Sheet1!A2:C2" },
      }),
    };
    const parsed = quickAddRowTool.inputSchema.parse({
      spreadsheet: "SID",
      values: ["a", 2, "=A2"],
    }) as Parameters<typeof quickAddRowTool.handler>[0];
    const out = await quickAddRowTool.handler(parsed, ctxOf(client));

    expect(client.appendValues).toHaveBeenCalledWith(
      "SID",
      "A1",
      [["a", 2, "=A2"]],
      "USER_ENTERED",
      "INSERT_ROWS",
    );
    expect(out).toEqual({ updated_range: "Sheet1!A2:C2" });
  });

  it("quotes a tab name with spaces into the append range", async () => {
    const client: FakeClient = {
      appendValues: vi.fn().mockResolvedValue({ updates: {} }),
    };
    const parsed = quickAddRowTool.inputSchema.parse({
      spreadsheet: "SID",
      values: ["x"],
      tab: "My Tab",
    }) as Parameters<typeof quickAddRowTool.handler>[0];
    await quickAddRowTool.handler(parsed, ctxOf(client));
    expect(client.appendValues.mock.calls[0]?.[1]).toBe("'My Tab'");
  });
});
