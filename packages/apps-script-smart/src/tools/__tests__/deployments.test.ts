import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  createDeploymentTool,
  listDeploymentsTool,
  getDeploymentTool,
  updateDeploymentTool,
  deleteDeploymentTool,
} from "../deployments.js";

function ctxOf(client: Record<string, unknown>): { client: never } {
  return { client: client as unknown as never };
}

describe("createDeploymentTool", () => {
  it("builds the config with the appsscript manifest default", async () => {
    const createDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "dep_1", deploymentConfig: {} });
    const input = createDeploymentTool.inputSchema.parse({
      script_id: "s1",
      version_number: 2,
    }) as Parameters<typeof createDeploymentTool.handler>[0];
    await createDeploymentTool.handler(input, ctxOf({ createDeployment }));
    expect(createDeployment).toHaveBeenCalledWith("s1", {
      versionNumber: 2,
      manifestFileName: "appsscript",
    });
  });

  it("omits versionNumber to deploy HEAD", async () => {
    const createDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "dep_head", deploymentConfig: {} });
    const input = createDeploymentTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof createDeploymentTool.handler>[0];
    await createDeploymentTool.handler(input, ctxOf({ createDeployment }));
    expect(createDeployment).toHaveBeenCalledWith("s1", {
      manifestFileName: "appsscript",
    });
  });
});

describe("listDeploymentsTool", () => {
  it("maps deployments + next_page_token", async () => {
    const listDeployments = vi.fn().mockResolvedValue({
      items: [{ deploymentId: "dep_1", deploymentConfig: { versionNumber: 1 } }],
      nextPageToken: "t",
    });
    const input = listDeploymentsTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof listDeploymentsTool.handler>[0];
    const out = await listDeploymentsTool.handler(
      input,
      ctxOf({ listDeployments }),
    );
    expect(out.deployments[0]?.deployment_id).toBe("dep_1");
    expect(out.next_page_token).toBe("t");
  });
});

describe("getDeploymentTool", () => {
  it("passes script_id + deployment_id", async () => {
    const getDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "dep_1", deploymentConfig: {} });
    const input = getDeploymentTool.inputSchema.parse({
      script_id: "s1",
      deployment_id: "dep_1",
    }) as Parameters<typeof getDeploymentTool.handler>[0];
    await getDeploymentTool.handler(input, ctxOf({ getDeployment }));
    expect(getDeployment).toHaveBeenCalledWith("s1", "dep_1");
  });
});

describe("updateDeploymentTool", () => {
  it("passes the new config to updateDeployment", async () => {
    const updateDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "dep_1", deploymentConfig: {} });
    const input = updateDeploymentTool.inputSchema.parse({
      script_id: "s1",
      deployment_id: "dep_1",
      version_number: 4,
    }) as Parameters<typeof updateDeploymentTool.handler>[0];
    await updateDeploymentTool.handler(input, ctxOf({ updateDeployment }));
    expect(updateDeployment).toHaveBeenCalledWith("s1", "dep_1", {
      versionNumber: 4,
      manifestFileName: "appsscript",
    });
  });
});

describe("deleteDeploymentTool — destructive gating", () => {
  it("throws ConfirmRequiredError without confirm and does not delete", async () => {
    const deleteDeployment = vi.fn();
    const input = deleteDeploymentTool.inputSchema.parse({
      script_id: "s1",
      deployment_id: "dep_1",
    }) as Parameters<typeof deleteDeploymentTool.handler>[0];
    await expect(
      deleteDeploymentTool.handler(input, ctxOf({ deleteDeployment })),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(deleteDeployment).not.toHaveBeenCalled();
  });

  it("preview names the deployment + project", async () => {
    const input = deleteDeploymentTool.inputSchema.parse({
      script_id: "s1",
      deployment_id: "dep_1",
    }) as Parameters<typeof deleteDeploymentTool.handler>[0];
    try {
      await deleteDeploymentTool.handler(input, ctxOf({ deleteDeployment: vi.fn() }));
    } catch (err) {
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("dep_1");
      expect(e.preview).toContain("s1");
    }
  });

  it("deletes when confirmed and returns { deleted: true }", async () => {
    const deleteDeployment = vi.fn().mockResolvedValue(undefined);
    const input = deleteDeploymentTool.inputSchema.parse({
      script_id: "s1",
      deployment_id: "dep_1",
      confirm: true,
    }) as Parameters<typeof deleteDeploymentTool.handler>[0];
    const out = await deleteDeploymentTool.handler(
      input,
      ctxOf({ deleteDeployment }),
    );
    expect(deleteDeployment).toHaveBeenCalledWith("s1", "dep_1");
    expect(out).toEqual({ deleted: true });
  });
});
