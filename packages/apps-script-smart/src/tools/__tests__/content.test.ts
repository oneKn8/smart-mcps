import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  getContentTool,
  updateContentTool,
  pushFileTool,
} from "../content.js";

type FakeClient = {
  getContent: ReturnType<typeof vi.fn>;
  updateContent: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    getContent: vi.fn(),
    updateContent: vi.fn(),
    ...over,
  };
}

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// ============================================================================
// get_content
// ============================================================================

describe("getContentTool", () => {
  it("maps content and forwards the optional version_number", async () => {
    const client = makeClient({
      getContent: vi.fn().mockResolvedValue({
        scriptId: "s1",
        files: [{ name: "Code", type: "SERVER_JS", source: "x" }],
      }),
    });
    const input = getContentTool.inputSchema.parse({
      script_id: "s1",
      version_number: 4,
    }) as Parameters<typeof getContentTool.handler>[0];
    const out = await getContentTool.handler(input, ctxOf(client));
    expect(client.getContent).toHaveBeenCalledWith("s1", 4);
    expect(out.content).toEqual({
      script_id: "s1",
      files: [{ name: "Code", type: "SERVER_JS", source: "x" }],
    });
  });
});

// ============================================================================
// update_content (FULL OVERWRITE — confirm-gated)
// ============================================================================

describe("updateContentTool", () => {
  it("throws ConfirmRequiredError when confirm is omitted (no write happens)", async () => {
    const client = makeClient();
    const input = updateContentTool.inputSchema.parse({
      script_id: "s1",
      files: [{ name: "appsscript", type: "JSON", source: "{}" }],
    }) as Parameters<typeof updateContentTool.handler>[0];
    await expect(
      updateContentTool.handler(input, ctxOf(client)),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.updateContent).not.toHaveBeenCalled();
  });

  it("preview names the files and warns about deletion of omitted files", async () => {
    const client = makeClient();
    const input = updateContentTool.inputSchema.parse({
      script_id: "s1",
      files: [
        { name: "Code", type: "SERVER_JS", source: "x" },
        { name: "appsscript", type: "JSON", source: "{}" },
      ],
    }) as Parameters<typeof updateContentTool.handler>[0];
    try {
      await updateContentTool.handler(input, ctxOf(client));
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("Code");
      expect(e.preview).toContain("appsscript");
      expect(e.preview.toUpperCase()).toContain("DELETED");
    }
  });

  it("preview warns when no appsscript manifest is included", async () => {
    const client = makeClient();
    const input = updateContentTool.inputSchema.parse({
      script_id: "s1",
      files: [{ name: "Code", type: "SERVER_JS", source: "x" }],
    }) as Parameters<typeof updateContentTool.handler>[0];
    try {
      await updateContentTool.handler(input, ctxOf(client));
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toContain("manifest");
    }
  });

  it("with confirm:true PUTs the exact file array and returns slim content", async () => {
    const client = makeClient({
      updateContent: vi
        .fn()
        .mockResolvedValue({ scriptId: "s1", files: [] }),
    });
    const files = [
      { name: "Code", type: "SERVER_JS", source: "x" },
      { name: "appsscript", type: "JSON", source: "{}" },
    ];
    const input = updateContentTool.inputSchema.parse({
      script_id: "s1",
      files,
      confirm: true,
    }) as Parameters<typeof updateContentTool.handler>[0];
    const out = await updateContentTool.handler(input, ctxOf(client));
    expect(client.updateContent).toHaveBeenCalledWith("s1", files);
    expect(out.content).toEqual({ script_id: "s1", files: [] });
  });
});

// ============================================================================
// push_file (SAFE wrapper — the preservation test)
// ============================================================================

const headContent = {
  scriptId: "s1",
  files: [
    {
      name: "Code",
      type: "SERVER_JS",
      source: "function old(){}",
      updateTime: "ignored",
      lastModifyUser: { email: "x" },
    },
    { name: "appsscript", type: "JSON", source: '{"timeZone":"America/Chicago"}' },
    { name: "page", type: "HTML", source: "<p>hi</p>" },
  ],
};

describe("pushFileTool — preserves the manifest and other files", () => {
  it("replacing one file re-sends ALL files (manifest intact), only the target changed", async () => {
    let sentFiles: unknown;
    const client = makeClient({
      getContent: vi.fn().mockResolvedValue(headContent),
      updateContent: vi.fn().mockImplementation((_id: string, files: unknown) => {
        sentFiles = files;
        return Promise.resolve({ scriptId: "s1", files });
      }),
    });
    const input = pushFileTool.inputSchema.parse({
      script_id: "s1",
      name: "Code",
      type: "SERVER_JS",
      source: "function fresh(){}",
    }) as Parameters<typeof pushFileTool.handler>[0];

    const out = await pushFileTool.handler(input, ctxOf(client));

    // Read-modify-write: getContent first, then updateContent with the full set.
    expect(client.getContent).toHaveBeenCalledWith("s1");
    // The whole project is re-sent: 3 files, read-only fields stripped.
    expect(sentFiles).toEqual([
      { name: "Code", type: "SERVER_JS", source: "function fresh(){}" },
      {
        name: "appsscript",
        type: "JSON",
        source: '{"timeZone":"America/Chicago"}',
      },
      { name: "page", type: "HTML", source: "<p>hi</p>" },
    ]);
    expect(out.replaced).toBe(true);
  });

  it("pushing Index/HTML does NOT clobber a sibling Index/SERVER_JS (match on name AND type)", async () => {
    // A project where a base name is shared across two file types — Apps Script
    // allows `Index.gs` (SERVER_JS) and `Index.html` (HTML) side by side.
    const dualNameContent = {
      scriptId: "s1",
      files: [
        { name: "Index", type: "SERVER_JS", source: "function doGet(){}" },
        { name: "Index", type: "HTML", source: "<p>old</p>" },
        { name: "appsscript", type: "JSON", source: "{}" },
      ],
    };
    let sentFiles: { name: string; type: string; source: string }[] | undefined;
    const client = makeClient({
      getContent: vi.fn().mockResolvedValue(dualNameContent),
      updateContent: vi
        .fn()
        .mockImplementation(
          (_id: string, files: { name: string; type: string; source: string }[]) => {
            sentFiles = files;
            return Promise.resolve({ scriptId: "s1", files });
          },
        ),
    });
    const input = pushFileTool.inputSchema.parse({
      script_id: "s1",
      name: "Index",
      type: "HTML",
      source: "<p>fresh</p>",
    }) as Parameters<typeof pushFileTool.handler>[0];

    const out = await pushFileTool.handler(input, ctxOf(client));
    const files = sentFiles ?? [];

    // The SERVER_JS Index survives byte-for-byte (NOT overwritten by the HTML).
    expect(files).toContainEqual({
      name: "Index",
      type: "SERVER_JS",
      source: "function doGet(){}",
    });
    // Exactly one HTML Index, carrying the new source — no duplicate (name,type).
    const htmlIndexes = files.filter(
      (f) => f.name === "Index" && f.type === "HTML",
    );
    expect(htmlIndexes).toEqual([
      { name: "Index", type: "HTML", source: "<p>fresh</p>" },
    ]);
    // Manifest untouched; total file count unchanged (replace, not add).
    expect(files).toHaveLength(3);
    expect(out.replaced).toBe(true);
  });

  it("adding a NEW file appends it while preserving every existing file + manifest", async () => {
    let sentFiles: { name: string }[] | undefined;
    const client = makeClient({
      getContent: vi.fn().mockResolvedValue(headContent),
      updateContent: vi
        .fn()
        .mockImplementation((_id: string, files: { name: string }[]) => {
          sentFiles = files;
          return Promise.resolve({ scriptId: "s1", files });
        }),
    });
    const input = pushFileTool.inputSchema.parse({
      script_id: "s1",
      name: "Utils",
      type: "SERVER_JS",
      source: "function util(){}",
    }) as Parameters<typeof pushFileTool.handler>[0];

    const out = await pushFileTool.handler(input, ctxOf(client));

    const names = (sentFiles ?? []).map((f) => f.name);
    expect(names).toEqual(["Code", "appsscript", "page", "Utils"]);
    // Manifest preserved untouched.
    expect(sentFiles).toContainEqual({
      name: "appsscript",
      type: "JSON",
      source: '{"timeZone":"America/Chicago"}',
    });
    expect(out.replaced).toBe(false);
  });
});
