import { vi } from "vitest";
import type { ZodTypeAny } from "zod";
import type { ToolDefinition } from "smart-mcp-core";
import type { FlowContext } from "../context.js";

/**
 * Build a fake FlowContext whose every client method is a `vi.fn()` stub.
 * flow-smart does no direct HTTP, so tool tests never need msw — they assert
 * the right sibling-client methods were called with the right args and that the
 * composed output shape is correct. Per-client `over` partials replace
 * individual stubs while keeping sensible defaults for the rest.
 */
export function makeCtx(over: {
  account?: string;
  tasks?: Record<string, unknown>;
  calendar?: Record<string, unknown>;
  docs?: Record<string, unknown>;
  email?: Record<string, unknown>;
  appsScript?: Record<string, unknown>;
} = {}): FlowContext {
  return {
    account: over.account ?? "acct",
    tasks: {
      getTask: vi.fn(),
      insertTask: vi.fn(),
      listTasks: vi.fn(),
      listTaskLists: vi.fn().mockResolvedValue({ items: [] }),
      ...over.tasks,
    },
    calendar: {
      ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
      insertEvent: vi.fn(),
      listEvents: vi.fn().mockResolvedValue({ items: [] }),
      ...over.calendar,
    },
    docs: {
      createDocument: vi
        .fn()
        .mockResolvedValue({ documentId: "doc1", title: "Rendered" }),
      batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
      getDocument: vi.fn(),
      ...over.docs,
    },
    email: {
      getThread: vi.fn(),
      getMessage: vi.fn(),
      listMessages: vi.fn(),
      ...over.email,
    },
    appsScript: {
      createProject: vi.fn(),
      updateContent: vi.fn().mockResolvedValue({}),
      createVersion: vi.fn(),
      createDeployment: vi.fn(),
      ...over.appsScript,
    },
  } as unknown as FlowContext;
}

/** Parse `raw` through the tool's schema (applying defaults) then run it. */
export async function run<I, O>(
  tool: ToolDefinition<I, O, FlowContext>,
  raw: unknown,
  ctx: FlowContext,
): Promise<O> {
  const parsed = (tool.inputSchema as ZodTypeAny).parse(raw) as I;
  return tool.handler(parsed, ctx);
}

/** The text inserted by the docs renderer's first flow batchUpdate request. */
export function renderedMarkdown(ctx: FlowContext): string {
  const batchUpdate = (ctx.docs as unknown as { batchUpdate: { mock: { calls: unknown[][] } } })
    .batchUpdate;
  const firstCall = batchUpdate.mock.calls[0]?.[0] as
    | { requests?: Array<{ insertText?: { text?: string } }> }
    | undefined;
  return firstCall?.requests?.[0]?.insertText?.text ?? "";
}
