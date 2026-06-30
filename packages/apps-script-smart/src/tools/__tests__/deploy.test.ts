import { describe, it, expect, vi } from "vitest";
import { deployScriptTool } from "../deploy.js";

function ctxOf(client: Record<string, unknown>): { client: never } {
  return { client: client as unknown as never };
}

describe("deployScriptTool — convenience composite", () => {
  it("creates a version THEN deploys that exact version, surfacing both ids", async () => {
    const createVersion = vi
      .fn()
      .mockResolvedValue({ scriptId: "s1", versionNumber: 7, description: "v" });
    const createDeployment = vi.fn().mockResolvedValue({
      deploymentId: "dep_9",
      deploymentConfig: { versionNumber: 7, manifestFileName: "appsscript" },
    });
    const input = deployScriptTool.inputSchema.parse({
      script_id: "s1",
      version_description: "v",
      description: "prod release",
    }) as Parameters<typeof deployScriptTool.handler>[0];

    const out = await deployScriptTool.handler(
      input,
      ctxOf({ createVersion, createDeployment }),
    );

    expect(createVersion).toHaveBeenCalledWith("s1", "v");
    // The deployment pins the freshly-created version number.
    expect(createDeployment).toHaveBeenCalledWith("s1", {
      versionNumber: 7,
      manifestFileName: "appsscript",
      description: "prod release",
    });
    expect(out.version.version_number).toBe(7);
    expect(out.deployment.deployment_id).toBe("dep_9");
  });

  it("throws when version creation returns no versionNumber (cannot deploy)", async () => {
    const createVersion = vi.fn().mockResolvedValue({ scriptId: "s1" });
    const createDeployment = vi.fn();
    const input = deployScriptTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof deployScriptTool.handler>[0];
    await expect(
      deployScriptTool.handler(input, ctxOf({ createVersion, createDeployment })),
    ).rejects.toThrow();
    expect(createDeployment).not.toHaveBeenCalled();
  });
});
