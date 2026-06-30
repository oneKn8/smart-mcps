import { describe, it, expect, vi } from "vitest";
import {
  createVersionTool,
  listVersionsTool,
  getVersionTool,
} from "../versions.js";

function ctxOf(client: Record<string, unknown>): { client: never } {
  return { client: client as unknown as never };
}

describe("createVersionTool", () => {
  it("passes script_id + description, maps the version", async () => {
    const createVersion = vi
      .fn()
      .mockResolvedValue({ scriptId: "s1", versionNumber: 2, description: "v2" });
    const input = createVersionTool.inputSchema.parse({
      script_id: "s1",
      description: "v2",
    }) as Parameters<typeof createVersionTool.handler>[0];
    const out = await createVersionTool.handler(input, ctxOf({ createVersion }));
    expect(createVersion).toHaveBeenCalledWith("s1", "v2");
    expect(out.version.version_number).toBe(2);
  });
});

describe("listVersionsTool", () => {
  it("maps items and surfaces next_page_token (null when absent)", async () => {
    const listVersions = vi
      .fn()
      .mockResolvedValue({ items: [{ versionNumber: 1 }] });
    const input = listVersionsTool.inputSchema.parse({
      script_id: "s1",
    }) as Parameters<typeof listVersionsTool.handler>[0];
    const out = await listVersionsTool.handler(input, ctxOf({ listVersions }));
    expect(listVersions).toHaveBeenCalledWith({ scriptId: "s1" });
    expect(out.versions).toHaveLength(1);
    expect(out.next_page_token).toBeNull();
  });

  it("forwards page_size + page_token when provided", async () => {
    const listVersions = vi
      .fn()
      .mockResolvedValue({ items: [], nextPageToken: "t2" });
    const input = listVersionsTool.inputSchema.parse({
      script_id: "s1",
      page_size: 10,
      page_token: "t1",
    }) as Parameters<typeof listVersionsTool.handler>[0];
    const out = await listVersionsTool.handler(input, ctxOf({ listVersions }));
    expect(listVersions).toHaveBeenCalledWith({
      scriptId: "s1",
      pageSize: 10,
      pageToken: "t1",
    });
    expect(out.next_page_token).toBe("t2");
  });
});

describe("getVersionTool", () => {
  it("passes script_id + version_number", async () => {
    const getVersion = vi
      .fn()
      .mockResolvedValue({ scriptId: "s1", versionNumber: 5 });
    const input = getVersionTool.inputSchema.parse({
      script_id: "s1",
      version_number: 5,
    }) as Parameters<typeof getVersionTool.handler>[0];
    const out = await getVersionTool.handler(input, ctxOf({ getVersion }));
    expect(getVersion).toHaveBeenCalledWith("s1", 5);
    expect(out.version.version_number).toBe(5);
  });
});
