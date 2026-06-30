import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import { renderMarkdownToNewDoc } from "docs-smart/render";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import {
  clamp,
  firstThreadMessage,
  mdInline,
  messageFrom,
  messageSubject,
  oneLine,
} from "../extract.js";

// =============================================================================
// inbox_digest_doc — summarize the N most recent unread threads into a Doc
// =============================================================================
//
// Glue: EmailClient.listMessages (unread refs) -> getThread per unique thread
// for subject/from/snippet -> `renderMarkdownToNewDoc`. Dedupes by threadId so
// "N threads" means N distinct conversations, not N messages.

const inboxDigestDocInputSchema = z.object({
  count: z.number().int().min(1).max(50).optional().default(10),
  /** Gmail search selecting the threads to digest. */
  query: z.string().min(1).optional().default("is:unread in:inbox"),
  title: z.string().min(1).optional(),
});

type InboxDigestDocInput = z.input<typeof inboxDigestDocInputSchema>;
type InboxDigestDocParsed = z.infer<typeof inboxDigestDocInputSchema>;

type DigestThread = {
  thread_id: string;
  subject: string;
  from: string | null;
};

type InboxDigestDocOutput = {
  document_id: string;
  url: string;
  title: string;
  thread_count: number;
  threads: DigestThread[];
};

export const inboxDigestDocTool = defineTool<
  InboxDigestDocInput,
  InboxDigestDocOutput,
  FlowContext
>({
  name: "inbox_digest_doc",
  description: "Summarize recent unread email into a doc",
  // Cast required: the schema has `.optional().default(...)` fields.
  inputSchema:
    inboxDigestDocInputSchema as unknown as z.ZodType<InboxDigestDocInput>,
  handler: async (input, ctx) => {
    const parsed = input as InboxDigestDocParsed;
    const progress = new FlowProgress();

    // Step: list unread message refs, dedupe to distinct threads (cap N).
    const threadIds = await progress.run("list_unread", async () => {
      const res = await ctx.email.listMessages(ctx.account, {
        q: parsed.query,
        maxResults: parsed.count * 3,
      });
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const ref of res.messages) {
        if (ref.threadId && !seen.has(ref.threadId)) {
          seen.add(ref.threadId);
          ids.push(ref.threadId);
          if (ids.length >= parsed.count) break;
        }
      }
      return ids;
    });
    progress.note(`found ${threadIds.length} unread threads`);

    // Step: fetch each thread's metadata + snippet.
    const digest = await progress.run("read_threads", async () => {
      const out: { thread: DigestThread; snippet: string }[] = [];
      for (const id of threadIds) {
        const thread = await ctx.email.getThread(ctx.account, id, "metadata");
        const first = firstThreadMessage(thread);
        out.push({
          thread: {
            thread_id: id,
            subject: messageSubject(first) ?? "(no subject)",
            from: messageFrom(first),
          },
          snippet: thread.snippet ?? "",
        });
      }
      return out;
    });

    // Build the Markdown string.
    const docTitle = parsed.title ?? `Inbox Digest — ${threadIds.length} unread`;
    const lines: string[] = [];
    lines.push(`# ${mdInline(docTitle)}`, "");
    // The query is echoed inside a Markdown code span. Collapse whitespace and
    // strip backticks: the docs renderer honors no backslash escapes, so a
    // backtick in the query would close the span early and a newline would
    // split the line. Every other marker is literal inside a code span, so the
    // backtick is the only character that can break it.
    const queryLabel = oneLine(parsed.query).replace(/`/g, "");
    lines.push(
      `${digest.length} unread thread(s) matching \`${queryLabel}\`.`,
      "",
    );
    if (digest.length === 0) {
      lines.push("Inbox is clear — nothing unread.", "");
    }
    digest.forEach((d, i) => {
      lines.push(`## ${i + 1}. ${mdInline(clamp(d.thread.subject, 120))}`, "");
      if (d.thread.from) lines.push(`**From:** ${mdInline(d.thread.from)}`, "");
      if (d.snippet.length > 0) lines.push(mdInline(clamp(d.snippet, 400)), "");
    });

    const rendered = await progress.run("render_doc", () =>
      renderMarkdownToNewDoc(ctx.docs, {
        title: docTitle,
        markdown: lines.join("\n"),
      }),
    );

    return {
      document_id: rendered.document_id,
      url: rendered.url,
      title: rendered.title,
      thread_count: digest.length,
      threads: digest.map((d) => d.thread),
    };
  },
});
