import { describe, it, expect } from "vitest";
import { mapDocument, readDocumentText } from "../doc-mapper.js";

describe("mapDocument", () => {
  it("slims to id/title/revision and drops the heavy body", () => {
    const slim = mapDocument({
      documentId: "doc_abc",
      title: "Quarterly Plan",
      revisionId: "rev_1",
      body: { content: [] },
      namedStyles: {},
    });
    expect(slim).toEqual({
      document_id: "doc_abc",
      title: "Quarterly Plan",
      revision_id: "rev_1",
    });
  });

  it("coerces a missing revisionId to null", () => {
    const slim = mapDocument({ documentId: "d", title: "t" });
    expect(slim.revision_id).toBeNull();
  });

  it("throws on a non-object", () => {
    expect(() => mapDocument(null)).toThrow();
  });
});

describe("readDocumentText — walks paragraphs", () => {
  it("concatenates textRun content across paragraphs and skips section breaks", () => {
    const doc = {
      body: {
        content: [
          { sectionBreak: {} },
          {
            paragraph: {
              elements: [
                { textRun: { content: "Hello " } },
                { textRun: { content: "world\n" } },
              ],
            },
          },
          {
            paragraph: { elements: [{ textRun: { content: "Second line\n" } }] },
          },
        ],
      },
    };
    expect(readDocumentText(doc)).toBe("Hello world\nSecond line\n");
  });

  it("ignores non-text paragraph elements (page breaks, images)", () => {
    const doc = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: "before" } },
                { pageBreak: {} },
                { inlineObjectElement: { inlineObjectId: "img1" } },
                { textRun: { content: "after\n" } },
              ],
            },
          },
        ],
      },
    };
    expect(readDocumentText(doc)).toBe("beforeafter\n");
  });
});

describe("readDocumentText — walks tables recursively", () => {
  it("reads cell text in row-major order", () => {
    const cell = (s: string) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: s } }] } }],
    });
    const doc = {
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: "intro\n" } }] } },
          {
            table: {
              tableRows: [
                { tableCells: [cell("A1\n"), cell("B1\n")] },
                { tableCells: [cell("A2\n"), cell("B2\n")] },
              ],
            },
          },
        ],
      },
    };
    expect(readDocumentText(doc)).toBe("intro\nA1\nB1\nA2\nB2\n");
  });
});

describe("readDocumentText — graceful on odd input", () => {
  it("returns empty string when there is no body content", () => {
    expect(readDocumentText({})).toBe("");
    expect(readDocumentText({ body: {} })).toBe("");
    expect(readDocumentText(null)).toBe("");
  });
});
