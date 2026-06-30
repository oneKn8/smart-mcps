import { describe, it, expect } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  BODY_START_INDEX,
  assertDeletableRange,
  assertNotTableStartIndex,
  assertValidInsertIndex,
  buildParagraphStyle,
  buildTextStyle,
  createParagraphBulletsRequest,
  deleteContentRangeRequest,
  documentEndIndex,
  fieldsMask,
  hexToColor,
  insertInlineImageRequest,
  insertPageBreakRequest,
  insertTableRequest,
  insertTextRequest,
  replaceAllTextRequest,
  tableCellSlots,
  tableStartIndices,
  updateTextStyleRequest,
} from "../request-builders.js";

// A small document fixture with one 2x2 table starting at index 5.
const DOC_WITH_TABLE = {
  body: {
    content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 5,
        paragraph: { elements: [{ textRun: { content: "Hi\n" } }] },
      },
      {
        startIndex: 5,
        endIndex: 40,
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ startIndex: 8, paragraph: {} }] },
                { content: [{ startIndex: 12, paragraph: {} }] },
              ],
            },
            {
              tableCells: [
                { content: [{ startIndex: 20, paragraph: {} }] },
                { content: [{ startIndex: 24, paragraph: {} }] },
              ],
            },
          ],
        },
      },
      {
        startIndex: 40,
        endIndex: 41,
        paragraph: { elements: [{ textRun: { content: "\n" } }] },
      },
    ],
  },
};

describe("BODY_START_INDEX", () => {
  it("is 1 (index 0 is the section break)", () => {
    expect(BODY_START_INDEX).toBe(1);
  });
});

describe("fieldsMask", () => {
  it("joins keys in insertion order", () => {
    expect(fieldsMask({ bold: true, italic: true })).toBe("bold,italic");
    expect(fieldsMask({ namedStyleType: "HEADING_1", alignment: "CENTER" })).toBe(
      "namedStyleType,alignment",
    );
  });
});

describe("buildTextStyle — builds the fields mask from EXACTLY the set fields", () => {
  it("bold only -> fields 'bold'", () => {
    const built = buildTextStyle({ bold: true });
    expect(built).toEqual({ textStyle: { bold: true }, fields: "bold" });
  });

  it("bold + italic -> fields 'bold,italic', other fields untouched", () => {
    const built = buildTextStyle({ bold: true, italic: true });
    expect(built?.fields).toBe("bold,italic");
    expect(built?.textStyle).toEqual({ bold: true, italic: true });
  });

  it("font size maps to a PT dimension under fontSize", () => {
    const built = buildTextStyle({ fontSize: 14 });
    expect(built).toEqual({
      textStyle: { fontSize: { magnitude: 14, unit: "PT" } },
      fields: "fontSize",
    });
  });

  it("font family maps to weightedFontFamily", () => {
    const built = buildTextStyle({ fontFamily: "Consolas" });
    expect(built).toEqual({
      textStyle: { weightedFontFamily: { fontFamily: "Consolas" } },
      fields: "weightedFontFamily",
    });
  });

  it("hex color maps to foregroundColor and the mask names only it", () => {
    const built = buildTextStyle({ foregroundColorHex: "#000000" });
    expect(built?.fields).toBe("foregroundColor");
    expect(built?.textStyle).toEqual({
      foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
    });
  });

  it("link maps to link.url with fields 'link'", () => {
    const built = buildTextStyle({ linkUrl: "https://example.test" });
    expect(built).toEqual({
      textStyle: { link: { url: "https://example.test" } },
      fields: "link",
    });
  });

  it("canonical key order regardless of input object order", () => {
    const built = buildTextStyle({ italic: true, bold: true });
    expect(built?.fields).toBe("bold,italic");
  });

  it("returns null when no attribute is set (a no-field update is a silent no-op)", () => {
    expect(buildTextStyle({})).toBeNull();
  });
});

describe("buildParagraphStyle", () => {
  it("named style + alignment -> fields 'namedStyleType,alignment'", () => {
    const built = buildParagraphStyle({
      namedStyleType: "HEADING_1",
      alignment: "CENTER",
    });
    expect(built?.fields).toBe("namedStyleType,alignment");
    expect(built?.paragraphStyle).toEqual({
      namedStyleType: "HEADING_1",
      alignment: "CENTER",
    });
  });

  it("indent maps to a PT dimension", () => {
    const built = buildParagraphStyle({ indentStart: 36 });
    expect(built).toEqual({
      paragraphStyle: { indentStart: { magnitude: 36, unit: "PT" } },
      fields: "indentStart",
    });
  });

  it("returns null when nothing is set", () => {
    expect(buildParagraphStyle({})).toBeNull();
  });
});

describe("hexToColor", () => {
  it("parses #RRGGBB into 0..1 channels", () => {
    expect(hexToColor("#ffffff")).toEqual({
      color: { rgbColor: { red: 1, green: 1, blue: 1 } },
    });
  });
  it("accepts a hex without the leading '#'", () => {
    const c = hexToColor("1a73e8");
    expect(c.color.rgbColor.red).toBeCloseTo(26 / 255);
    expect(c.color.rgbColor.green).toBeCloseTo(115 / 255);
    expect(c.color.rgbColor.blue).toBeCloseTo(232 / 255);
  });
  it("throws ValidationError on a bad hex", () => {
    expect(() => hexToColor("nope")).toThrow(ValidationError);
  });
});

describe("insertTextRequest", () => {
  it("builds a location-index insert", () => {
    expect(insertTextRequest({ text: "x", index: 1 })).toEqual({
      insertText: { text: "x", location: { index: 1 } },
    });
  });
  it("builds an end-of-segment append", () => {
    expect(insertTextRequest({ text: "x", endOfSegment: true })).toEqual({
      insertText: { text: "x", endOfSegmentLocation: {} },
    });
  });
  it("rejects index 0 (the section break is not writable)", () => {
    expect(() => insertTextRequest({ text: "x", index: 0 })).toThrow(
      ValidationError,
    );
  });
  it("requires index or endOfSegment", () => {
    expect(() => insertTextRequest({ text: "x" })).toThrow(ValidationError);
  });
});

describe("deleteContentRangeRequest / replaceAllTextRequest", () => {
  it("builds a delete range", () => {
    expect(deleteContentRangeRequest({ startIndex: 3, endIndex: 9 })).toEqual({
      deleteContentRange: { range: { startIndex: 3, endIndex: 9 } },
    });
  });
  it("builds a case-sensitive replaceAllText", () => {
    expect(
      replaceAllTextRequest({ find: "{{x}}", replace: "Y", matchCase: true }),
    ).toEqual({
      replaceAllText: {
        containsText: { text: "{{x}}", matchCase: true },
        replaceText: "Y",
      },
    });
  });
  it("defaults matchCase to false", () => {
    const r = replaceAllTextRequest({ find: "a", replace: "b" }) as {
      replaceAllText: { containsText: { matchCase: boolean } };
    };
    expect(r.replaceAllText.containsText.matchCase).toBe(false);
  });
});

describe("updateTextStyleRequest / createParagraphBulletsRequest", () => {
  it("wraps range + textStyle + fields", () => {
    expect(
      updateTextStyleRequest({
        startIndex: 1,
        endIndex: 5,
        textStyle: { bold: true },
        fields: "bold",
      }),
    ).toEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 5 },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
  });
  it("builds bullets over a range", () => {
    expect(
      createParagraphBulletsRequest({
        startIndex: 1,
        endIndex: 10,
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      }),
    ).toEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 10 },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  });
});

describe("insertTableRequest / insertInlineImageRequest / insertPageBreakRequest", () => {
  it("table at an index", () => {
    expect(insertTableRequest({ rows: 2, columns: 3, index: 1 })).toEqual({
      insertTable: { rows: 2, columns: 3, location: { index: 1 } },
    });
  });
  it("image with size", () => {
    expect(
      insertInlineImageRequest({ uri: "https://x/y.png", index: 1, width: 100 }),
    ).toEqual({
      insertInlineImage: {
        uri: "https://x/y.png",
        objectSize: { width: { magnitude: 100, unit: "PT" } },
        location: { index: 1 },
      },
    });
  });
  it("page break at end of segment", () => {
    expect(insertPageBreakRequest({ endOfSegment: true })).toEqual({
      insertPageBreak: { endOfSegmentLocation: {} },
    });
  });
});

describe("structural guards", () => {
  it("tableStartIndices finds the table start", () => {
    expect(tableStartIndices(DOC_WITH_TABLE)).toEqual([5]);
  });

  it("documentEndIndex returns the last element endIndex", () => {
    expect(documentEndIndex(DOC_WITH_TABLE)).toBe(41);
  });

  it("assertValidInsertIndex rejects < 1", () => {
    expect(() => assertValidInsertIndex(0)).toThrow(ValidationError);
    expect(() => assertValidInsertIndex(1)).not.toThrow();
  });

  it("assertNotTableStartIndex rejects inserting at a table's start", () => {
    expect(() => assertNotTableStartIndex(DOC_WITH_TABLE, 5)).toThrow(
      ValidationError,
    );
    expect(() => assertNotTableStartIndex(DOC_WITH_TABLE, 3)).not.toThrow();
  });

  it("assertDeletableRange rejects deleting the final newline", () => {
    // body end is 41; final newline is [40,41). endIndex 41 would delete it.
    expect(() => assertDeletableRange(DOC_WITH_TABLE, 1, 41)).toThrow(
      ValidationError,
    );
    expect(() => assertDeletableRange(DOC_WITH_TABLE, 1, 40)).not.toThrow();
  });

  it("assertDeletableRange rejects empty/backwards ranges and index < 1", () => {
    expect(() => assertDeletableRange(DOC_WITH_TABLE, 5, 5)).toThrow(
      ValidationError,
    );
    expect(() => assertDeletableRange(DOC_WITH_TABLE, 0, 3)).toThrow(
      ValidationError,
    );
  });
});

// ===========================================================================
// FINDING 4 (LOW): assertDeletableRange must also protect the final newline of
// a TABLE CELL, not only the body's. A cell's last paragraph newline cannot be
// deleted (the API 400s). The cell's content range is available in the body.
// ===========================================================================

// A doc with a table cell whose content paragraph spans [6,12): the cell's
// final newline lives at [11,12). The body end (31) is well past it, so the
// body-end guard does NOT fire for ranges that end at the cell's newline.
const DOC_WITH_CELL_NEWLINE = {
  body: {
    content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 4,
        paragraph: { elements: [{ textRun: { content: "Hi\n" } }] },
      },
      {
        startIndex: 4,
        endIndex: 30,
        table: {
          tableRows: [
            {
              tableCells: [
                {
                  startIndex: 5,
                  content: [
                    {
                      startIndex: 6,
                      endIndex: 12,
                      paragraph: { elements: [{ textRun: { content: "abc\n" } }] },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        startIndex: 30,
        endIndex: 31,
        paragraph: { elements: [{ textRun: { content: "\n" } }] },
      },
    ],
  },
};

describe("assertDeletableRange — table cell final newline (Finding 4)", () => {
  it("rejects deleting a table cell's final newline", () => {
    // cell content is [6,12); the final newline is [11,12). endIndex 12 deletes it.
    expect(() => assertDeletableRange(DOC_WITH_CELL_NEWLINE, 6, 12)).toThrow(
      ValidationError,
    );
    // Deleting only part of the cell text but reaching its newline still throws.
    expect(() => assertDeletableRange(DOC_WITH_CELL_NEWLINE, 7, 12)).toThrow(
      ValidationError,
    );
  });

  it("allows deleting cell text that stops before the cell's final newline", () => {
    expect(() => assertDeletableRange(DOC_WITH_CELL_NEWLINE, 6, 11)).not.toThrow();
  });

  it("still allows ordinary body deletes that never touch a cell newline", () => {
    expect(() => assertDeletableRange(DOC_WITH_CELL_NEWLINE, 1, 3)).not.toThrow();
  });

  it("is conservative when cell content lacks an endIndex (no false positives)", () => {
    // DOC_WITH_TABLE's cells carry only startIndex; the cell guard must skip
    // them rather than block a legitimate in-table delete.
    expect(() => assertDeletableRange(DOC_WITH_TABLE, 8, 12)).not.toThrow();
  });
});

describe("tableCellSlots", () => {
  it("returns row-major cell insertion indexes from a real table", () => {
    const { rows, columns, slots } = tableCellSlots(DOC_WITH_TABLE, 0);
    expect(rows).toBe(2);
    expect(columns).toBe(2);
    expect(slots).toEqual([
      { row: 0, column: 0, index: 8 },
      { row: 0, column: 1, index: 12 },
      { row: 1, column: 0, index: 20 },
      { row: 1, column: 1, index: 24 },
    ]);
  });

  it("throws when the table ordinal is out of range", () => {
    expect(() => tableCellSlots(DOC_WITH_TABLE, 3)).toThrow(ValidationError);
  });
});
