import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type {
  HetznerBody,
  HetznerAction,
  HetznerClient,
} from "../client.js";
import {
  waitField,
  confirmField,
  settleAction,
  summarizeAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableString } from "./null-helpers.js";

// =============================================================================
// Slim shapes + mappers
// =============================================================================

// Slim view of a Hetzner Firewall. Rule/target arrays are collapsed to counts so
// list responses stay compact; get_firewall re-hydrates the rules array.
export type SlimFirewall = {
  id: number;
  name: string | null;
  rules_count: number;
  applied_to_count: number;
  labels: Record<string, string>;
};

// Slim view of a single firewall rule (get_firewall passthrough).
export type SlimRule = {
  direction: string | null;
  protocol: string | null;
  port: string | null;
  source_ips: string[];
  destination_ips: string[];
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function mapFirewall(raw: Record<string, unknown>): SlimFirewall {
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const appliedTo = Array.isArray(raw.applied_to) ? raw.applied_to : [];
  const labelsRaw = asObject(raw.labels);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: nullableString(raw.name),
    rules_count: rules.length,
    applied_to_count: appliedTo.length,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

export function mapRule(raw: Record<string, unknown>): SlimRule {
  return {
    direction: nullableString(raw.direction),
    protocol: nullableString(raw.protocol),
    port: nullableString(raw.port),
    source_ips: asStringArray(raw.source_ips),
    destination_ips: asStringArray(raw.destination_ips),
  };
}

// =============================================================================
// Shared rule / apply_to builders
// =============================================================================

const ruleSchema = z.object({
  direction: z.enum(["in", "out"]),
  protocol: z.enum(["tcp", "udp", "icmp", "esp", "gre"]),
  port: z.string().optional(),
  source_ips: z.array(z.string()).optional(),
  destination_ips: z.array(z.string()).optional(),
  description: z.string().optional(),
});

type RuleInput = z.infer<typeof ruleSchema>;

// Forwards only the fields the caller actually set, in the Hetzner rule shape.
function buildRules(rules: RuleInput[]): Array<Record<string, unknown>> {
  return rules.map((r) => {
    const rule: Record<string, unknown> = {
      direction: r.direction,
      protocol: r.protocol,
    };
    if (r.port !== undefined) rule.port = r.port;
    if (r.source_ips !== undefined) rule.source_ips = r.source_ips;
    if (r.destination_ips !== undefined) rule.destination_ips = r.destination_ips;
    if (r.description !== undefined) rule.description = r.description;
    return rule;
  });
}

// Builds the `apply_to` targets array from server ids + a label selector.
function buildApplyTo(
  serverIds: number[] | undefined,
  labelSelector: string | undefined,
): Array<Record<string, unknown>> {
  const applyTo: Array<Record<string, unknown>> = [];
  if (serverIds) {
    for (const id of serverIds) {
      applyTo.push({ type: "server", server: { id } });
    }
  }
  if (labelSelector !== undefined) {
    applyTo.push({
      type: "label_selector",
      label_selector: { selector: labelSelector },
    });
  }
  return applyTo;
}

// Firewall action endpoints return `{ actions: [...] }`. Settle each one (poll
// to completion when `wait` and still running) and return the slim summaries.
async function settleActions(
  client: HetznerClient,
  body: HetznerBody,
  wait: boolean,
): Promise<ActionSummary[]> {
  const rawActions: unknown[] = Array.isArray(body.actions) ? body.actions : [];
  const out: ActionSummary[] = [];
  for (const raw of rawActions) {
    const settled = await settleAction(client, { action: raw }, wait);
    if (settled) out.push(settled);
  }
  return out;
}

// =============================================================================
// list_firewalls
// =============================================================================

const listFirewallsInputSchema = z.object({
  name: z.string().optional(),
  label_selector: z.string().optional(),
});

type ListFirewallsInput = z.infer<typeof listFirewallsInputSchema>;

type ListFirewallsOutput = {
  firewalls: SlimFirewall[];
  count: number;
};

export const listFirewalls = defineTool<
  ListFirewallsInput,
  ListFirewallsOutput,
  HetznerContext
>({
  name: "list_firewalls",
  description: "List firewalls.",
  inputSchema: listFirewallsInputSchema,
  handler: async (input, context) => {
    const body = await context.client.listFirewalls({
      name: input.name,
      label_selector: input.label_selector,
    });
    const raw = Array.isArray(body.firewalls) ? body.firewalls : [];
    const firewalls = raw.map((f) => mapFirewall(f as Record<string, unknown>));
    return { firewalls, count: firewalls.length };
  },
});

// =============================================================================
// get_firewall
// =============================================================================

const getFirewallInputSchema = z.object({
  firewall_id: z.number().int().positive(),
});

type GetFirewallInput = z.infer<typeof getFirewallInputSchema>;

type GetFirewallOutput = SlimFirewall & { rules: SlimRule[] };

export const getFirewall = defineTool<
  GetFirewallInput,
  GetFirewallOutput,
  HetznerContext
>({
  name: "get_firewall",
  description: "Get a firewall with its rules.",
  inputSchema: getFirewallInputSchema,
  handler: async (input, context) => {
    const raw = await context.client.getFirewall(input.firewall_id);
    const rulesRaw: unknown[] = Array.isArray(raw.rules) ? raw.rules : [];
    return {
      ...mapFirewall(raw),
      rules: rulesRaw.map((r) => mapRule(r as Record<string, unknown>)),
    };
  },
});

// =============================================================================
// create_firewall
// =============================================================================

const createFirewallInputSchema = z.object({
  name: z.string().min(1),
  rules: z.array(ruleSchema).optional(),
  apply_to_server_ids: z.array(z.number().int().positive()).optional(),
  apply_to_label_selector: z.string().optional(),
  labels: z.record(z.string()).optional(),
});

type CreateFirewallInput = z.infer<typeof createFirewallInputSchema>;

type CreateFirewallOutput = {
  firewall_id: number;
  name: string;
  actions: ActionSummary[];
};

export const createFirewall = defineTool<
  CreateFirewallInput,
  CreateFirewallOutput,
  HetznerContext
>({
  name: "create_firewall",
  description: "Create a firewall.",
  inputSchema: createFirewallInputSchema,
  handler: async (input, context) => {
    const payload: Record<string, unknown> = { name: input.name };
    if (input.rules !== undefined) payload.rules = buildRules(input.rules);
    const applyTo = buildApplyTo(
      input.apply_to_server_ids,
      input.apply_to_label_selector,
    );
    if (applyTo.length > 0) payload.apply_to = applyTo;
    if (input.labels !== undefined) payload.labels = input.labels;

    const body = await context.client.createFirewall(payload);
    const firewall = asObject(body.firewall);
    const rawActions: unknown[] = Array.isArray(body.actions)
      ? body.actions
      : [];
    return {
      firewall_id: typeof firewall?.id === "number" ? firewall.id : 0,
      name: nullableString(firewall?.name) ?? input.name,
      actions: rawActions.map((a) => summarizeAction(a as HetznerAction)),
    };
  },
});

// =============================================================================
// delete_firewall
// =============================================================================

const deleteFirewallInputSchema = z.object({
  firewall_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteFirewallInput = z.infer<typeof deleteFirewallInputSchema>;

type DeleteFirewallOutput = {
  firewall_id: number;
  deleted: true;
};

export const deleteFirewall = defineTool<
  DeleteFirewallInput,
  DeleteFirewallOutput,
  HetznerContext
>({
  name: "delete_firewall",
  description: "Delete a firewall.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    deleteFirewallInputSchema as unknown as z.ZodType<DeleteFirewallInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE firewall ${input.firewall_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteFirewall(input.firewall_id);
    return { firewall_id: input.firewall_id, deleted: true };
  },
});

// =============================================================================
// set_firewall_rules
// =============================================================================

const setFirewallRulesInputSchema = z.object({
  firewall_id: z.number().int().positive(),
  rules: z.array(ruleSchema),
  wait: waitField,
});

type SetFirewallRulesInput = z.infer<typeof setFirewallRulesInputSchema>;

type SetFirewallRulesOutput = {
  firewall_id: number;
  actions: ActionSummary[];
};

export const setFirewallRules = defineTool<
  SetFirewallRulesInput,
  SetFirewallRulesOutput,
  HetznerContext
>({
  name: "set_firewall_rules",
  description: "Replace a firewall's rules.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    setFirewallRulesInputSchema as unknown as z.ZodType<SetFirewallRulesInput>,
  handler: async (input, context) => {
    const body = await context.client.firewallAction(
      input.firewall_id,
      "set_rules",
      { rules: buildRules(input.rules) },
    );
    const actions = await settleActions(context.client, body, input.wait);
    return { firewall_id: input.firewall_id, actions };
  },
});

// =============================================================================
// apply_firewall
// =============================================================================

const applyFirewallInputSchema = z.object({
  firewall_id: z.number().int().positive(),
  server_ids: z.array(z.number().int().positive()).optional(),
  label_selector: z.string().optional(),
  wait: waitField,
});

type ApplyFirewallInput = z.infer<typeof applyFirewallInputSchema>;

type ApplyFirewallOutput = {
  firewall_id: number;
  actions: ActionSummary[];
};

export const applyFirewall = defineTool<
  ApplyFirewallInput,
  ApplyFirewallOutput,
  HetznerContext
>({
  name: "apply_firewall",
  description: "Apply a firewall to servers.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    applyFirewallInputSchema as unknown as z.ZodType<ApplyFirewallInput>,
  handler: async (input, context) => {
    const applyTo = buildApplyTo(input.server_ids, input.label_selector);
    const body = await context.client.firewallAction(
      input.firewall_id,
      "apply_to_resources",
      { apply_to: applyTo },
    );
    const actions = await settleActions(context.client, body, input.wait);
    return { firewall_id: input.firewall_id, actions };
  },
});
