import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { summarizeAction, type ActionSummary } from "./wait-schema.js";

// Action inspection tools. Every mutating Hetzner endpoint returns an async
// Action; these two let a caller poll one by id directly. Both are read-only —
// no `confirm`, no side effect beyond an outbound GET — so they slim the raw
// HetznerAction to the shared ActionSummary shape (dropping started/resources/
// error) via `summarizeAction`.

// =============================================================================
// get_action
// =============================================================================

const getActionInputSchema = z.object({
  action_id: z.number().int().positive(),
});

type GetActionInput = z.infer<typeof getActionInputSchema>;

export const getAction = defineTool<GetActionInput, ActionSummary, HetznerContext>(
  {
    name: "get_action",
    description: "Get an action by ID.",
    inputSchema: getActionInputSchema,
    handler: async (input, context) => {
      const action = await context.client.getAction(input.action_id);
      return summarizeAction(action);
    },
  },
);

// =============================================================================
// wait_for_action
// =============================================================================

const waitForActionInputSchema = z.object({
  action_id: z.number().int().positive(),
  timeout_seconds: z.number().int().positive().optional().default(120),
});

type WaitForActionInput = z.infer<typeof waitForActionInputSchema>;

export const waitForAction = defineTool<
  WaitForActionInput,
  ActionSummary,
  HetznerContext
>({
  name: "wait_for_action",
  description: "Poll an action until it settles.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: waitForActionInputSchema as unknown as z.ZodType<WaitForActionInput>,
  handler: async (input, context) => {
    const action = await context.client.waitForAction(input.action_id, {
      timeoutMs: input.timeout_seconds * 1000,
    });
    return summarizeAction(action);
  },
});
