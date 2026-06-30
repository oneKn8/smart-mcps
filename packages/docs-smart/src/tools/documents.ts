import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import { mapDocument, readDocumentText, type SlimDocument } from "../doc-mapper.js";
import { insertTextRequest, BODY_START_INDEX } from "../request-builders.js";

/** Editor URL for a document id. */
export function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

// =============================================================================
// get_document
// =============================================================================

const getDocumentInputSchema = z.object({
  document_id: z.string().min(1),
  include_tabs_content: z.boolean().optional().default(false),
  suggestions_view_mode: z.string().optional(),
});

type GetDocumentInput = z.input<typeof getDocumentInputSchema>;
type GetDocumentParsed = z.infer<typeof getDocumentInputSchema>;
type GetDocumentOutput = { document: SlimDocument };

export const getDocumentTool = defineTool<
  GetDocumentInput,
  GetDocumentOutput,
  DocsContext
>({
  name: "get_document",
  description: "Get document metadata by ID",
  // Cast required because the schema has `.optional().default(...)` fields.
  inputSchema: getDocumentInputSchema as unknown as z.ZodType<GetDocumentInput>,
  handler: async (input, ctx) => {
    const parsed = input as GetDocumentParsed;
    const raw = await ctx.client.getDocument({
      documentId: parsed.document_id,
      includeTabsContent: parsed.include_tabs_content,
      ...(parsed.suggestions_view_mode !== undefined
        ? { suggestionsViewMode: parsed.suggestions_view_mode }
        : {}),
    });
    return { document: mapDocument(raw) };
  },
});

// =============================================================================
// read_text
// =============================================================================

const readTextInputSchema = z.object({
  document_id: z.string().min(1),
});

type ReadTextInput = z.infer<typeof readTextInputSchema>;
type ReadTextOutput = { text: string };

export const readTextTool = defineTool<ReadTextInput, ReadTextOutput, DocsContext>({
  name: "read_text",
  description: "Read document body as plain text",
  inputSchema: readTextInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getDocument({ documentId: input.document_id });
    return { text: readDocumentText(raw) };
  },
});

// =============================================================================
// create_document  (create is TITLE-ONLY; optional initial text via batchUpdate)
// =============================================================================

const createDocumentInputSchema = z.object({
  title: z.string().min(1),
  text: z.string().optional(),
});

type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;
type CreateDocumentOutput = {
  document_id: string;
  title: string;
  url: string;
};

export const createDocumentTool = defineTool<
  CreateDocumentInput,
  CreateDocumentOutput,
  DocsContext
>({
  name: "create_document",
  description: "Create a new document with a title",
  inputSchema: createDocumentInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.createDocument({ title: input.title });
    const documentId =
      typeof raw.documentId === "string" ? raw.documentId : "";
    const title = typeof raw.title === "string" ? raw.title : input.title;
    if (input.text !== undefined && input.text.length > 0) {
      // `create` ignores body content, so seed the initial text in a follow-up
      // batchUpdate at the first writable index.
      await ctx.client.batchUpdate({
        documentId,
        requests: [insertTextRequest({ text: input.text, index: BODY_START_INDEX })],
      });
    }
    return { document_id: documentId, title, url: docUrl(documentId) };
  },
});
