import { describe, it, expect, vi } from "vitest";
import { createProjectTool, getProjectTool } from "../projects.js";

type FakeClient = {
  createProject: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
};

function ctxOf(client: Partial<FakeClient>): { client: never } {
  return { client: client as unknown as never };
}

describe("createProjectTool", () => {
  it("passes title + parentId and returns a slim project", async () => {
    const createProject = vi
      .fn()
      .mockResolvedValue({ scriptId: "s_new", title: "T", parentId: "doc1" });
    const input = createProjectTool.inputSchema.parse({
      title: "T",
      parent_id: "doc1",
    }) as Parameters<typeof createProjectTool.handler>[0];
    const out = await createProjectTool.handler(input, ctxOf({ createProject }));
    expect(createProject).toHaveBeenCalledWith({ title: "T", parentId: "doc1" });
    expect(out.project).toEqual({
      script_id: "s_new",
      title: "T",
      parent_id: "doc1",
      create_time: null,
      update_time: null,
      creator: null,
      last_modify_user: null,
    });
  });

  it("omits parentId when parent_id not supplied", async () => {
    const createProject = vi
      .fn()
      .mockResolvedValue({ scriptId: "s_new", title: "T" });
    const input = createProjectTool.inputSchema.parse({
      title: "T",
    }) as Parameters<typeof createProjectTool.handler>[0];
    await createProjectTool.handler(input, ctxOf({ createProject }));
    expect(createProject).toHaveBeenCalledWith({ title: "T" });
  });
});

describe("getProjectTool", () => {
  it("fetches by script_id and maps", async () => {
    const getProject = vi
      .fn()
      .mockResolvedValue({ scriptId: "s1", title: "Mine" });
    const input = getProjectTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof getProjectTool.handler>[0];
    const out = await getProjectTool.handler(input, ctxOf({ getProject }));
    expect(getProject).toHaveBeenCalledWith("s1");
    expect(out.project.script_id).toBe("s1");
  });
});
