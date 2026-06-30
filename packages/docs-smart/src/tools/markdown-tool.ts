import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import { renderMarkdownToNewDoc } from "../render.js";

// Re-exported for tests / external callers that imported it from here before
// the renderer was extracted into `../render.js`. The implementation now lives
// in render.ts so flow-smart can reuse it without going through the tool layer.
export { buildAllTableFillRequests } from "../render.js";

// =============================================================================
// create_doc_from_markdown  (FLAGSHIP)
// =============================================================================
//
// Thin tool wrapper: parse input, then delegate to `renderMarkdownToNewDoc`,
// which owns the Phase A/B/C index-safe render (see render.ts). The tool used
// to inline that logic; extracting it lets flow-smart's doc tools render
// through the exact same path with zero markdown-logic duplication.

const createDocFromMarkdownInputSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
});

type CreateDocFromMarkdownInput = z.infer<
  typeof createDocFromMarkdownInputSchema
>;
type CreateDocFromMarkdownOutput = {
  document_id: string;
  title: string;
  url: string;
  tables_filled: number;
};

export const createDocFromMarkdownTool = defineTool<
  CreateDocFromMarkdownInput,
  CreateDocFromMarkdownOutput,
  DocsContext
>({
  name: "create_doc_from_markdown",
  description: "Render markdown into a new Google Doc",
  inputSchema: createDocFromMarkdownInputSchema,
  handler: async (input, ctx) =>
    renderMarkdownToNewDoc(ctx.client, {
      title: input.title,
      markdown: input.markdown,
    }),
});
