import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import {
  clamp,
  firstThreadMessage,
  messageSnippet,
  messageSubject,
  readTask,
  toDueTimestamp,
} from "../extract.js";

// =============================================================================
// email_to_task — Gmail message/thread -> Google Task
// =============================================================================
//
// Glue: EmailClient.getThread/getMessage to read the subject + snippet, then
// TasksClient.insertTask to file it. Exactly one of `thread_id` / `message_id`
// is required. `due` is a date-only `YYYY-MM-DD` (Tasks discards time).

const emailToTaskInputSchema = z
  .object({
    thread_id: z.string().min(1).optional(),
    message_id: z.string().min(1).optional(),
    /** Task list to file into. `@default` is the user's primary list. */
    tasklist: z.string().min(1).optional().default("@default"),
    /** Optional due date, `YYYY-MM-DD` (date-only — Tasks stores no time). */
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD")
      .optional(),
  })
  .refine((v) => (v.thread_id === undefined) !== (v.message_id === undefined), {
    message: "provide exactly one of thread_id or message_id",
  });

type EmailToTaskInput = z.input<typeof emailToTaskInputSchema>;
type EmailToTaskParsed = z.infer<typeof emailToTaskInputSchema>;

type EmailToTaskOutput = {
  task_id: string;
  tasklist: string;
  title: string;
  notes: string | null;
  due: string | null;
  source: { thread_id: string | null; message_id: string | null };
};

export const emailToTaskTool = defineTool<
  EmailToTaskInput,
  EmailToTaskOutput,
  FlowContext
>({
  name: "email_to_task",
  description: "Create a task from a Gmail message",
  // Cast required: the schema has an `.optional().default(...)` field (+ refine).
  inputSchema: emailToTaskInputSchema as unknown as z.ZodType<EmailToTaskInput>,
  handler: async (input, ctx) => {
    const parsed = input as EmailToTaskParsed;
    const progress = new FlowProgress();

    // Step 1: read the email and lift its subject + snippet.
    const { subject, snippet } = await progress.run("read_email", async () => {
      if (parsed.thread_id !== undefined) {
        const thread = await ctx.email.getThread(
          ctx.account,
          parsed.thread_id,
          "metadata",
        );
        const first = firstThreadMessage(thread);
        return {
          subject: messageSubject(first),
          snippet: thread.snippet ?? messageSnippet(first),
        };
      }
      const message = await ctx.email.getMessage(
        ctx.account,
        parsed.message_id as string,
        "metadata",
      );
      return { subject: messageSubject(message), snippet: messageSnippet(message) };
    });

    const title = subject !== null ? clamp(subject, 1024) : "(no subject)";
    const sourceRef =
      parsed.thread_id !== undefined
        ? `Gmail thread ${parsed.thread_id}`
        : `Gmail message ${parsed.message_id}`;
    const notes =
      snippet && snippet.length > 0
        ? `${clamp(snippet, 800)}\n\nFrom ${sourceRef}`
        : `From ${sourceRef}`;
    progress.note(`read email "${title}"`);

    // Step 2: file the task.
    const raw = await progress.run("create_task", () => {
      const body: Record<string, unknown> = { title, notes };
      if (parsed.due !== undefined) body.due = toDueTimestamp(parsed.due);
      return ctx.tasks.insertTask({ tasklist: parsed.tasklist, body });
    });
    const task = readTask(raw);
    if (task.id.length === 0) {
      throw new ValidationError(
        "create_task: Tasks API returned a task with no id.",
      );
    }

    return {
      task_id: task.id,
      tasklist: parsed.tasklist,
      title: task.title.length > 0 ? task.title : title,
      notes: task.notes,
      due: task.due ?? parsed.due ?? null,
      source: {
        thread_id: parsed.thread_id ?? null,
        message_id: parsed.message_id ?? null,
      },
    };
  },
});
