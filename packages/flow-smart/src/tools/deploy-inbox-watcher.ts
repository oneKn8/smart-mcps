import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import { buildWatcherScript } from "../watcher-script.js";

// =============================================================================
// deploy_inbox_watcher — scaffold + deploy a Gmail-poll -> Tasks Apps Script
// =============================================================================
//
// Glue over AppsScriptClient ONLY: generate the script, create the project,
// write Code.gs + the appsscript.json manifest, snapshot a version, deploy it.
//
// HONEST LIMITATION (surfaced in the result): the Apps Script REST API cannot
// install a time trigger. The generated script ships an install function the
// user runs ONCE by hand to arm the ScriptApp time-trigger; only then does the
// watcher poll on its own. We return that exact next step and never claim the
// deploy alone makes it live.

const deployInboxWatcherInputSchema = z.object({
  project_title: z.string().min(1).optional().default("Inbox Watcher"),
  /** Gmail search the watcher polls. */
  query: z.string().min(1).optional().default("is:unread in:inbox"),
  /** Task list new tasks land in. `@default` is the user's primary list. */
  tasklist: z.string().min(1).optional().default("@default"),
  /** Poll cadence in minutes; clamped to Apps Script's {1,5,10,15,30}. */
  every_minutes: z.number().int().min(1).max(60).optional().default(15),
  /** Max threads processed per poll. */
  max_threads: z.number().int().min(1).max(100).optional().default(25),
});

type DeployInboxWatcherInput = z.input<typeof deployInboxWatcherInputSchema>;
type DeployInboxWatcherParsed = z.infer<typeof deployInboxWatcherInputSchema>;

type DeployInboxWatcherOutput = {
  script_id: string;
  version_number: number;
  deployment_id: string;
  poll_function: string;
  install_function: string;
  every_minutes: number;
  editor_url: string;
  next_step: string;
};

const POLL_FUNCTION = "pollInboxToTasks";
const INSTALL_FUNCTION = "installTrigger";

function readField(raw: unknown, key: string): unknown {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[key]
    : undefined;
}

export const deployInboxWatcherTool = defineTool<
  DeployInboxWatcherInput,
  DeployInboxWatcherOutput,
  FlowContext
>({
  name: "deploy_inbox_watcher",
  description: "Deploy Gmail-to-Tasks Apps Script watcher",
  // Cast required: the schema has `.optional().default(...)` fields.
  inputSchema:
    deployInboxWatcherInputSchema as unknown as z.ZodType<DeployInboxWatcherInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeployInboxWatcherParsed;
    const progress = new FlowProgress();

    const script = buildWatcherScript({
      query: parsed.query,
      tasklist: parsed.tasklist,
      pollFunction: POLL_FUNCTION,
      installFunction: INSTALL_FUNCTION,
      everyMinutes: parsed.every_minutes,
      maxThreads: parsed.max_threads,
    });

    // Step: create the project.
    const scriptId = await progress.run("create_project", async () => {
      const proj = await ctx.appsScript.createProject(ctx.account, {
        title: parsed.project_title,
      });
      const id = readField(proj, "scriptId");
      if (typeof id !== "string" || id.length === 0) {
        throw new ValidationError(
          "create_project: Apps Script API returned no scriptId.",
        );
      }
      return id;
    });
    progress.note(`created project ${scriptId}`);

    // Step: write Code.gs + the manifest (full-overwrite; both files supplied).
    await progress.run("write_content", () =>
      ctx.appsScript.updateContent(ctx.account, scriptId, [
        { name: "appsscript", type: "JSON", source: script.manifest },
        { name: "Code", type: "SERVER_JS", source: script.code },
      ]),
    );
    progress.note("wrote Code.gs + manifest");

    // Step: snapshot an immutable version.
    const versionNumber = await progress.run("create_version", async () => {
      const ver = await ctx.appsScript.createVersion(
        ctx.account,
        scriptId,
        "inbox watcher v1",
      );
      const n = readField(ver, "versionNumber");
      if (typeof n !== "number") {
        throw new ValidationError(
          "create_version: Apps Script API returned no versionNumber.",
        );
      }
      return n;
    });
    progress.note(`created version ${versionNumber}`);

    // Step: deploy that version.
    const deploymentId = await progress.run("create_deployment", async () => {
      const dep = await ctx.appsScript.createDeployment(ctx.account, scriptId, {
        versionNumber,
        description: "inbox watcher",
      });
      const id = readField(dep, "deploymentId");
      if (typeof id !== "string" || id.length === 0) {
        throw new ValidationError(
          "create_deployment: Apps Script API returned no deploymentId.",
        );
      }
      return id;
    });

    return {
      script_id: scriptId,
      version_number: versionNumber,
      deployment_id: deploymentId,
      poll_function: POLL_FUNCTION,
      install_function: INSTALL_FUNCTION,
      every_minutes: script.everyMinutes,
      editor_url: `https://script.google.com/d/${scriptId}/edit`,
      next_step:
        `Open the script editor (${`https://script.google.com/d/${scriptId}/edit`}) ` +
        `and run \`${INSTALL_FUNCTION}()\` ONCE to arm the time trigger. The Apps ` +
        `Script API cannot create triggers; this single manual run installs the ` +
        `ScriptApp time-trigger that then polls Gmail every ${script.everyMinutes} ` +
        `minutes and files tasks on its own.`,
    };
  },
});
