import { describe, it, expect, vi } from "vitest";
import {
  getDocumentTool,
  readTextTool,
  createDocumentTool,
} from "../documents.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    getDocument: vi.fn(),
    createDocument: vi.fn(),
    batchUpdate: vi.fn(),
    ...over,
  };
}

const ctx = (client: unknown) => ({ client: client as never });

describe("getDocumentTool", () => {
  it("name + description budget", () => {
    expect(getDocumentTool.name).toBe("get_document");
    expect(getDocumentTool.description.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it("returns the slim document shape", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue({
        documentId: "doc_1",
        title: "Plan",
        revisionId: "rev_9",
        body: { content: [] },
      }),
    });
    const parsed = getDocumentTool.inputSchema.parse({
      document_id: "doc_1",
    }) as Parameters<typeof getDocumentTool.handler>[0];
    const out = await getDocumentTool.handler(parsed, ctx(client));
    expect(out).toEqual({
      document: { document_id: "doc_1", title: "Plan", revision_id: "rev_9" },
    });
    expect(client.getDocument).toHaveBeenCalledWith({
      documentId: "doc_1",
      includeTabsContent: false,
    });
  });
});

describe("readTextTool", () => {
  it("walks the doc into plain text", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue({
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: "Hello\n" } }] } },
          ],
        },
      }),
    });
    const parsed = readTextTool.inputSchema.parse({
      document_id: "doc_1",
    }) as Parameters<typeof readTextTool.handler>[0];
    const out = await readTextTool.handler(parsed, ctx(client));
    expect(out).toEqual({ text: "Hello\n" });
  });
});

describe("createDocumentTool", () => {
  it("creates title-only and returns id + url, no batchUpdate when no text", async () => {
    const client = makeClient({
      createDocument: vi.fn().mockResolvedValue({
        documentId: "doc_new",
        title: "Fresh",
      }),
    });
    const parsed = createDocumentTool.inputSchema.parse({
      title: "Fresh",
    }) as Parameters<typeof createDocumentTool.handler>[0];
    const out = await createDocumentTool.handler(parsed, ctx(client));
    expect(client.createDocument).toHaveBeenCalledWith({ title: "Fresh" });
    expect(client.batchUpdate).not.toHaveBeenCalled();
    expect(out).toEqual({
      document_id: "doc_new",
      title: "Fresh",
      url: "https://docs.google.com/document/d/doc_new/edit",
    });
  });

  it("seeds initial text via a follow-up batchUpdate at index 1", async () => {
    const client = makeClient({
      createDocument: vi.fn().mockResolvedValue({ documentId: "doc_new", title: "T" }),
      batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    });
    const parsed = createDocumentTool.inputSchema.parse({
      title: "T",
      text: "Body text",
    }) as Parameters<typeof createDocumentTool.handler>[0];
    await createDocumentTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "doc_new",
      requests: [{ insertText: { text: "Body text", location: { index: 1 } } }],
    });
  });
});
