import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  setTextStyleTool,
  setParagraphStyleTool,
  setHeadingTool,
  makeBulletsTool,
  removeBulletsTool,
} from "../styles.js";

function makeClient() {
  return { batchUpdate: vi.fn().mockResolvedValue({ replies: [] }) };
}
const ctx = (client: unknown) => ({ client: client as never });

function firstRequest(client: { batchUpdate: ReturnType<typeof vi.fn> }): unknown {
  return client.batchUpdate.mock.calls[0]?.[0].requests[0];
}

describe("setTextStyleTool — builds the fields mask from exactly the set fields", () => {
  it("bold + italic -> fields 'bold,italic'", async () => {
    const client = makeClient();
    const parsed = setTextStyleTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 5,
      bold: true,
      italic: true,
    }) as Parameters<typeof setTextStyleTool.handler>[0];
    const out = await setTextStyleTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 5 },
        textStyle: { bold: true, italic: true },
        fields: "bold,italic",
      },
    });
    expect(out).toEqual({ document_id: "d", fields: "bold,italic" });
  });

  it("font_size only -> fields 'fontSize' with a PT dimension", async () => {
    const client = makeClient();
    const parsed = setTextStyleTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 5,
      font_size: 18,
    }) as Parameters<typeof setTextStyleTool.handler>[0];
    await setTextStyleTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 5 },
        textStyle: { fontSize: { magnitude: 18, unit: "PT" } },
        fields: "fontSize",
      },
    });
  });

  it("rejects when no style attribute is provided", async () => {
    const client = makeClient();
    const parsed = setTextStyleTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 5,
    }) as Parameters<typeof setTextStyleTool.handler>[0];
    await expect(setTextStyleTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("rejects an inverted range", async () => {
    const client = makeClient();
    const parsed = setTextStyleTool.inputSchema.parse({
      document_id: "d",
      start_index: 5,
      end_index: 2,
      bold: true,
    }) as Parameters<typeof setTextStyleTool.handler>[0];
    await expect(setTextStyleTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("setParagraphStyleTool", () => {
  it("named style + alignment -> fields 'namedStyleType,alignment'", async () => {
    const client = makeClient();
    const parsed = setParagraphStyleTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 14,
      named_style_type: "HEADING_2",
      alignment: "CENTER",
    }) as Parameters<typeof setParagraphStyleTool.handler>[0];
    const out = await setParagraphStyleTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 14 },
        paragraphStyle: { namedStyleType: "HEADING_2", alignment: "CENTER" },
        fields: "namedStyleType,alignment",
      },
    });
    expect(out.fields).toBe("namedStyleType,alignment");
  });
});

describe("setHeadingTool", () => {
  it("maps the heading choice to a namedStyleType with the 'namedStyleType' mask", async () => {
    const client = makeClient();
    const parsed = setHeadingTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 8,
      heading: "title",
    }) as Parameters<typeof setHeadingTool.handler>[0];
    const out = await setHeadingTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 8 },
        paragraphStyle: { namedStyleType: "TITLE" },
        fields: "namedStyleType",
      },
    });
    expect(out.named_style_type).toBe("TITLE");
  });
});

describe("makeBulletsTool / removeBulletsTool", () => {
  it("unordered by default", async () => {
    const client = makeClient();
    const parsed = makeBulletsTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 20,
    }) as Parameters<typeof makeBulletsTool.handler>[0];
    const out = await makeBulletsTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 20 },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
    expect(out.preset).toBe("BULLET_DISC_CIRCLE_SQUARE");
  });

  it("ordered switches to the numbered preset", async () => {
    const client = makeClient();
    const parsed = makeBulletsTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 20,
      ordered: true,
    }) as Parameters<typeof makeBulletsTool.handler>[0];
    await makeBulletsTool.handler(parsed, ctx(client));
    expect(
      (firstRequest(client) as { createParagraphBullets: { bulletPreset: string } })
        .createParagraphBullets.bulletPreset,
    ).toBe("NUMBERED_DECIMAL_ALPHA_ROMAN");
  });

  it("remove_bullets emits deleteParagraphBullets", async () => {
    const client = makeClient();
    const parsed = removeBulletsTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 20,
    }) as Parameters<typeof removeBulletsTool.handler>[0];
    await removeBulletsTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      deleteParagraphBullets: { range: { startIndex: 1, endIndex: 20 } },
    });
  });
});
