import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { DocsContext } from "../context.js";

// =============================================================================
// batch_update  (raw escape hatch: forward a requests[] array verbatim)
// =============================================================================

const batchUpdateInputSchema = z.object({
  document_id: z.string().min(1),
  requests: z.array(z.record(z.string(), z.unknown())).min(1),
  write_control: z.record(z.string(), z.unknown()).optional(),
});

type BatchUpdateInput = z.infer<typeof batchUpdateInputSchema>;
type BatchUpdateOutput = { document_id: string; replies: unknown[] };

export const batchUpdateTool = defineTool<
  BatchUpdateInput,
  BatchUpdateOutput,
  DocsContext
>({
  name: "batch_update",
  description: "Forward raw batchUpdate requests verbatim",
  inputSchema: batchUpdateInputSchema,
  handler: async (input, ctx) => {
    // zod already enforces a non-empty array; double-guard for callers that
    // bypass schema parsing (defensive — this is the unrestricted escape hatch).
    if (!Array.isArray(input.requests) || input.requests.length === 0) {
      throw new ValidationError(
        "batch_update requires a non-empty `requests` array.",
      );
    }
    const res = await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: input.requests,
      ...(input.write_control !== undefined
        ? { writeControl: input.write_control }
        : {}),
    });
    return { document_id: input.document_id, replies: res.replies ?? [] };
  },
});
