import { describe, it, expect, vi } from "vitest";
import { deployInboxWatcherTool } from "../tools/deploy-inbox-watcher.js";
import { FlowStepError } from "../flow-error.js";
import { makeCtx, run } from "./helpers.js";

function watcherCtx(over: Record<string, unknown> = {}) {
  return makeCtx({
    appsScript: {
      createProject: vi.fn().mockResolvedValue({ scriptId: "S1" }),
      updateContent: vi.fn().mockResolvedValue({}),
      createVersion: vi.fn().mockResolvedValue({ versionNumber: 1 }),
      createDeployment: vi.fn().mockResolvedValue({ deploymentId: "D1" }),
      ...over,
    },
  });
}

describe("deploy_inbox_watcher", () => {
  it("creates the project, writes both files, versions, and deploys", async () => {
    const ctx = watcherCtx();
    const out = await run(deployInboxWatcherTool, {}, ctx);

    const as = ctx.appsScript as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(as.createProject).toHaveBeenCalledWith("acct", { title: "Inbox Watcher" });

    const [account, scriptId, files] = as.updateContent.mock.calls[0];
    expect(account).toBe("acct");
    expect(scriptId).toBe("S1");
    const manifest = files.find((f: { name: string }) => f.name === "appsscript");
    const code = files.find((f: { name: string }) => f.name === "Code");
    expect(manifest.type).toBe("JSON");
    expect(manifest.source).toContain("enabledAdvancedServices");
    expect(code.type).toBe("SERVER_JS");
    expect(code.source).toContain("ScriptApp.newTrigger");

    expect(as.createVersion).toHaveBeenCalledWith("acct", "S1", "inbox watcher v1");
    expect(as.createDeployment).toHaveBeenCalledWith("acct", "S1", {
      versionNumber: 1,
      description: "inbox watcher",
    });

    expect(out).toMatchObject({
      script_id: "S1",
      version_number: 1,
      deployment_id: "D1",
      poll_function: "pollInboxToTasks",
      install_function: "installTrigger",
      every_minutes: 15,
    });
    expect(out.next_step).toContain("installTrigger");
    expect(out.next_step).toContain("cannot create triggers");
    expect(out.editor_url).toContain("S1");
  });

  it("surfaces full partial progress when the deployment step fails", async () => {
    const ctx = watcherCtx({
      createDeployment: vi.fn().mockRejectedValue(new Error("deploy quota")),
    });

    const err = await run(deployInboxWatcherTool, {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("create_deployment");
    expect(err.completed).toEqual([
      "created project S1",
      "wrote Code.gs + manifest",
      "created version 1",
    ]);
    expect(err.message).toContain("created project S1");
    expect(err.message).toContain("created version 1");
    expect(err.message).toContain("deploy quota");
  });

  it("stops with a clear error if the project has no scriptId", async () => {
    const ctx = watcherCtx({ createProject: vi.fn().mockResolvedValue({}) });
    const err = await run(deployInboxWatcherTool, {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(FlowStepError);
    expect(err.step).toBe("create_project");
    const as = ctx.appsScript as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(as.updateContent).not.toHaveBeenCalled();
  });
});
