import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { resolveAccount } from "./account.js";

// =============================================================================
// run_function (scripts.run) — THE LOADED GUN
//
// This is arbitrary remote code execution AS THE USER with whatever Google
// scopes the script declares. It is `guardDestructive`-gated (confirm
// required, preview shows the exact target/function/parameters/devMode) and
// must NEVER be placed on an auto-approve allowlist — see the README.
// =============================================================================

const runFunctionInputSchema = z.object({
  /** Account to run AS; omit for the default identity. */
  account: z.string().optional(),
  /**
   * Preferred target: the API Executable DeploymentID (required in the new
   * IDE). Either this or `script_id` must be set; `deployment_id` wins.
   */
  deployment_id: z.string().optional(),
  /** Fallback target: the bare script ID (classic-editor single-API only). */
  script_id: z.string().optional(),
  /** Bare function name to invoke — no parens, no args here. */
  function: z.string().min(1),
  /** Positional arguments; JSON primitives/arrays/objects only. */
  parameters: z.array(z.unknown()).optional().default([]),
  /**
   * When true AND you own the script, runs the latest SAVED (HEAD) code
   * instead of the deployed version. Useless for non-owners.
   */
  dev_mode: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type RunFunctionInput = z.input<typeof runFunctionInputSchema>;
type RunFunctionParsed = z.infer<typeof runFunctionInputSchema>;
type RunFunctionOutput = { done: true; result: unknown };

export const runFunctionTool = defineTool<
  RunFunctionInput,
  RunFunctionOutput,
  AppsScriptContext
>({
  name: "run_function",
  description: "Run a script function (gated, runs as you)",
  // Cast required because `parameters`, `dev_mode`, `confirm` have defaults.
  inputSchema:
    runFunctionInputSchema as unknown as z.ZodType<RunFunctionInput>,
  handler: async (input, ctx) => {
    const parsed = input as RunFunctionParsed;
    const account = resolveAccount(parsed.account, ctx);

    if (
      parsed.deployment_id === undefined &&
      parsed.script_id === undefined
    ) {
      throw new ValidationError(
        "run_function requires deployment_id (preferred) or script_id.",
      );
    }

    const usingDeployment = parsed.deployment_id !== undefined;
    const target = usingDeployment
      ? (parsed.deployment_id as string)
      : (parsed.script_id as string);
    const targetLabel = usingDeployment ? "deploymentId" : "scriptId";

    // The preview is the safety surface: the exact code-exec the caller is
    // about to authorize. Show the account it runs AS plus all four fields
    // verbatim — the account is load-bearing here (the script executes with
    // that identity's granted Google scopes).
    const preview =
      "Run an Apps Script function AS YOU (arbitrary remote code execution).\n" +
      `account: ${account}\n` +
      `${targetLabel}: ${target}\n` +
      `function: ${parsed.function}\n` +
      `parameters: ${JSON.stringify(parsed.parameters)}\n` +
      `devMode: ${parsed.dev_mode}`;
    guardDestructive({ confirm: parsed.confirm, preview });

    return ctx.client.runFunction(account, {
      id: target,
      functionName: parsed.function,
      parameters: parsed.parameters,
      devMode: parsed.dev_mode,
    });
  },
});
