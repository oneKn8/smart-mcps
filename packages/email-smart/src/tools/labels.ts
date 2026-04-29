import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { EmailContext } from "../context.js";

// ---------- list_labels ----------

const listLabelsInputSchema = z.object({
  account: z.string().min(1),
});

type ListLabelsInput = z.infer<typeof listLabelsInputSchema>;

type SlimLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  messages_total?: number;
  messages_unread?: number;
  threads_unread?: number;
};

type ListLabelsOutput = {
  labels: SlimLabel[];
  count: number;
};

function coerceLabelType(t: string): "system" | "user" {
  return t === "system" ? "system" : "user";
}

export const listLabels = defineTool<
  ListLabelsInput,
  ListLabelsOutput,
  EmailContext
>({
  name: "list_labels",
  description: "List all Gmail labels for account.",
  inputSchema: listLabelsInputSchema,
  handler: async (input, context) => {
    const basics = await context.client.listLabels(input.account);
    const out: SlimLabel[] = [];

    for (const basic of basics) {
      try {
        const detail = await context.client.getLabel(input.account, basic.id);
        const slim: SlimLabel = {
          id: detail.id,
          name: detail.name,
          type: coerceLabelType(detail.type),
        };
        if (detail.messagesTotal !== undefined)
          slim.messages_total = detail.messagesTotal;
        if (detail.messagesUnread !== undefined)
          slim.messages_unread = detail.messagesUnread;
        if (detail.threadsUnread !== undefined)
          slim.threads_unread = detail.threadsUnread;
        out.push(slim);
      } catch {
        // Skip the single label whose detail fetch failed; surface the rest.
        continue;
      }
    }

    return { labels: out, count: out.length };
  },
});
