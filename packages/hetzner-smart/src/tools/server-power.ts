import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { mapServer } from "./server-mapper.js";

// Every power tool returns the same envelope: the target server id plus the
// settled (or still-running) power action. `action` is null only if upstream
// hands back no action envelope, which the Hetzner power endpoints never do.
type PowerActionOutput = {
  server_id: number;
  action: ActionSummary | null;
};

// =============================================================================
// power_on
// =============================================================================

const powerOnInputSchema = z.object({
  server_id: z.number().int().positive(),
  wait: waitField,
});

type PowerOnInput = z.infer<typeof powerOnInputSchema>;

export const powerOn = defineTool<PowerOnInput, PowerActionOutput, HetznerContext>({
  name: "power_on",
  description: "Power on a server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: powerOnInputSchema as unknown as z.ZodType<PowerOnInput>,
  handler: async (input, context) => {
    const body = await context.client.serverAction(input.server_id, "poweron");
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action };
  },
});

// =============================================================================
// power_off
// =============================================================================

const powerOffInputSchema = z.object({
  server_id: z.number().int().positive(),
  wait: waitField,
});

type PowerOffInput = z.infer<typeof powerOffInputSchema>;

// Not confirm-gated: a graceful ACPI power-off is recoverable, so no destructive
// preview. (Hard reset — a data-losing power cut — is the guarded twin below.)
export const powerOff = defineTool<PowerOffInput, PowerActionOutput, HetznerContext>({
  name: "power_off",
  description: "Power off a server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: powerOffInputSchema as unknown as z.ZodType<PowerOffInput>,
  handler: async (input, context) => {
    const body = await context.client.serverAction(input.server_id, "poweroff");
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action };
  },
});

// =============================================================================
// reboot
// =============================================================================

const rebootInputSchema = z.object({
  server_id: z.number().int().positive(),
  wait: waitField,
});

type RebootInput = z.infer<typeof rebootInputSchema>;

export const reboot = defineTool<RebootInput, PowerActionOutput, HetznerContext>({
  name: "reboot",
  description: "Reboot a server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: rebootInputSchema as unknown as z.ZodType<RebootInput>,
  handler: async (input, context) => {
    const body = await context.client.serverAction(input.server_id, "reboot");
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action };
  },
});

// =============================================================================
// reset
// =============================================================================

const resetInputSchema = z.object({
  server_id: z.number().int().positive(),
  confirm: confirmField,
  wait: waitField,
});

type ResetInput = z.infer<typeof resetInputSchema>;

// Confirm-gated: `reset` is a hard power cycle (equivalent to yanking the plug),
// so unsaved/in-flight data can be lost. The preview names the real server so
// the caller confirms against the right machine.
export const reset = defineTool<ResetInput, PowerActionOutput, HetznerContext>({
  name: "reset",
  description: "Hard reset a server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: resetInputSchema as unknown as z.ZodType<ResetInput>,
  handler: async (input, context) => {
    // Fetch first so the preview carries the real server name (honest scope).
    const server = mapServer(await context.client.getServer(input.server_id));
    const name = server.name.length > 0 ? server.name : `id ${input.server_id}`;
    const preview =
      `Will HARD RESET server ${name} (id ${input.server_id}) — abrupt power cycle, unsaved data may be lost`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = await context.client.serverAction(input.server_id, "reset");
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action };
  },
});
