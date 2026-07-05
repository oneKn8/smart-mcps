import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { nullableString } from "./null-helpers.js";

// Slim view of a container registry credential. Upstream deliberately returns
// only `{ id, name }` — the username/password are write-only and never echoed,
// so there is nothing secret to strip here. We still map through the shared
// null-helper so a missing `name` becomes null rather than undefined.
export type SlimRegistryAuth = {
  id: string;
  name: string | null;
};

function mapAuth(auth: Record<string, unknown>): SlimRegistryAuth {
  return {
    id: typeof auth.id === "string" ? auth.id : "",
    name: nullableString(auth.name),
  };
}

// =============================================================================
// list_registry_auths
// =============================================================================

const listRegistryAuthsInputSchema = z.object({});

type ListRegistryAuthsInput = z.infer<typeof listRegistryAuthsInputSchema>;

type ListRegistryAuthsOutput = {
  registryAuths: SlimRegistryAuth[];
  count: number;
};

export const listRegistryAuths = defineTool<
  ListRegistryAuthsInput,
  ListRegistryAuthsOutput,
  RunpodContext
>({
  name: "list_registry_auths",
  description: "List container registry credentials.",
  inputSchema: listRegistryAuthsInputSchema,
  handler: async (_input, context) => {
    const { registryAuths } = await context.client.listRegistryAuths();
    return {
      registryAuths: registryAuths.map((a) =>
        mapAuth(a as Record<string, unknown>),
      ),
      count: registryAuths.length,
    };
  },
});

// =============================================================================
// create_registry_auth
// =============================================================================

const createRegistryAuthInputSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type CreateRegistryAuthInput = z.infer<typeof createRegistryAuthInputSchema>;

export const createRegistryAuth = defineTool<
  CreateRegistryAuthInput,
  SlimRegistryAuth,
  RunpodContext
>({
  name: "create_registry_auth",
  description: "Store private container registry credentials.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema:
    createRegistryAuthInputSchema as unknown as z.ZodType<CreateRegistryAuthInput>,
  handler: async (input, context) => {
    // SECRET DISCIPLINE: the preview names only the credential label and the
    // username. The password is NEVER interpolated into the preview, the
    // returned output, or any log line — the upstream response echoes only
    // `{ id, name }` by design.
    const preview =
      `Will store registry credentials ${input.name} for user ${input.username}`;
    guardDestructive({ confirm: input.confirm, preview });

    const created = await context.client.createRegistryAuth({
      name: input.name,
      username: input.username,
      password: input.password,
    });
    return mapAuth(created as Record<string, unknown>);
  },
});

// =============================================================================
// get_registry_auth
// =============================================================================

const getRegistryAuthInputSchema = z.object({
  auth_id: z.string().min(1),
});

type GetRegistryAuthInput = z.infer<typeof getRegistryAuthInputSchema>;

export const getRegistryAuth = defineTool<
  GetRegistryAuthInput,
  SlimRegistryAuth,
  RunpodContext
>({
  name: "get_registry_auth",
  description: "Get a registry credential by ID.",
  inputSchema: getRegistryAuthInputSchema,
  handler: async (input, context) => {
    const auth = await context.client.getRegistryAuth(input.auth_id);
    return mapAuth(auth as Record<string, unknown>);
  },
});

// =============================================================================
// delete_registry_auth
// =============================================================================

const deleteRegistryAuthInputSchema = z.object({
  auth_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteRegistryAuthInput = z.infer<typeof deleteRegistryAuthInputSchema>;

type DeleteRegistryAuthOutput = {
  auth_id: string;
  deleted: true;
};

export const deleteRegistryAuth = defineTool<
  DeleteRegistryAuthInput,
  DeleteRegistryAuthOutput,
  RunpodContext
>({
  name: "delete_registry_auth",
  description: "Delete a registry credential.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema:
    deleteRegistryAuthInputSchema as unknown as z.ZodType<DeleteRegistryAuthInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE registry credential ${input.auth_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteRegistryAuth(input.auth_id);
    return { auth_id: input.auth_id, deleted: true };
  },
});
