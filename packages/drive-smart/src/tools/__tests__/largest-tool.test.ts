import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bytes } from "../../format.js";
import { buildContext, type DriveContext } from "../../context.js";
import type { IndexedFile } from "../../types.js";
import { driveLargest as tool } from "../largest.js";

// SlimFile keys as documented by file-mapper.ts. `account` is present only when
// the underlying indexed file carries one; the bookkeeping fields
// (root_id, root_label, relative_path, modified_ms, kind) must never leak.
const SLIM_FILE_KEYS_WITH_ACCOUNT = [
  "id",
  "name",
  "path",
  "account",
  "size",
  "size_human",
  "extension",
];
const SLIM_FILE_KEYS_NO_ACCOUNT = SLIM_FILE_KEYS_WITH_ACCOUNT.filter(k => k !== "account");
const LEAKED_KEYS = ["root_id", "root_label", "relative_path", "modified_ms", "kind"];

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-largest-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build the tool context: home at the temp dir, gvfsBase at an EMPTY temp dir. */
function ctx(): DriveContext {
  const gvfs = path.join(tmp, "empty-gvfs");
  fs.mkdirSync(gvfs, { recursive: true });
  return buildContext({ home: tmp, gvfsBase: gvfs });
}

/** Write an index.json envelope with the given files under the state dir. */
function writeIndex(files: IndexedFile[]): void {
  const dir = path.join(tmp, ".santo-agent", "drive-smart");
  fs.mkdirSync(dir, { recursive: true });
  const index = {
    version: 1,
    generated_at: "2026-05-26T12:00:00.000Z",
    roots: [],
    files,
    skipped: [],
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
}

/** Build an IndexedFile record; `account: undefined` is dropped by JSON.stringify. */
function makeFile(
  over: Partial<IndexedFile> & { name: string; size: number },
): IndexedFile {
  return {
    id: over.id ?? `root:${over.name}`,
    root_id: over.root_id ?? "root-a",
    root_label: over.root_label ?? "Root A",
    account: over.account,
    path: over.path ?? `/data/${over.name}`,
    relative_path: over.relative_path ?? over.name,
    name: over.name,
    extension: over.extension ?? path.extname(over.name).toLowerCase(),
    size: over.size,
    modified_ms: over.modified_ms ?? 1_700_000_000_000,
    kind: "file",
  };
}

function run(input: unknown) {
  return tool.handler(tool.inputSchema.parse(input), ctx());
}

describe("drive_largest metadata", () => {
  it("exposes the exact tool name", () => {
    expect(tool.name).toBe("drive_largest");
  });

  it("has a non-empty string description", () => {
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });
});

describe("drive_largest schema", () => {
  it("rejects a limit below the minimum", () => {
    expect(() => tool.inputSchema.parse({ limit: 0 })).toThrow();
  });

  it("rejects a limit above the maximum", () => {
    expect(() => tool.inputSchema.parse({ limit: 501 })).toThrow();
  });

  it("rejects a non-numeric limit", () => {
    expect(() => tool.inputSchema.parse({ limit: "big" })).toThrow();
  });

  it("resolves the documented default limit for an empty input", () => {
    const parsed = tool.inputSchema.parse({}) as { limit: number };
    expect(parsed.limit).toBe(25);
  });
});

describe("drive_largest output shape", () => {
  it("returns exactly count and results at the top level", async () => {
    writeIndex([makeFile({ name: "a.bin", size: 100 })]);
    const result = await run({});
    expect(Object.keys(result).sort()).toEqual(["count", "results"].sort());
  });

  it("strips bookkeeping fields to the SlimFile shape (with account)", async () => {
    writeIndex([makeFile({ name: "big.bin", size: 999, account: "alpha@example.com" })]);
    const result = await run({});
    const first = result.results[0]!;
    expect(Object.keys(first).sort()).toEqual(SLIM_FILE_KEYS_WITH_ACCOUNT.sort());
    for (const leaked of LEAKED_KEYS) {
      expect(first).not.toHaveProperty(leaked);
    }
  });

  it("omits account from SlimFile when the indexed file has none", async () => {
    writeIndex([makeFile({ name: "no-acct.bin", size: 500 })]);
    const result = await run({});
    const first = result.results[0]!;
    expect(Object.keys(first).sort()).toEqual(SLIM_FILE_KEYS_NO_ACCOUNT.sort());
    expect(first).not.toHaveProperty("account");
  });

  it("computes a human-readable size string", async () => {
    writeIndex([makeFile({ name: "kb.bin", size: 1536 })]);
    const result = await run({});
    expect(result.results[0]!.size_human).toBe(bytes(1536));
    expect(result.results[0]!.size_human).toBe("1.5 KB");
  });
});

describe("drive_largest behavior", () => {
  it("sorts results by size descending", async () => {
    writeIndex([
      makeFile({ name: "a.bin", size: 300 }),
      makeFile({ name: "b.bin", size: 100 }),
      makeFile({ name: "c.bin", size: 500 }),
      makeFile({ name: "d.bin", size: 200 }),
    ]);
    const result = await run({});
    expect(result.count).toBe(4);
    expect(result.results.map(f => f.name)).toEqual([
      "c.bin",
      "a.bin",
      "d.bin",
      "b.bin",
    ]);
    expect(result.results.map(f => f.size)).toEqual([500, 300, 200, 100]);
  });

  it("caps the result set at the requested limit, keeping the largest", async () => {
    writeIndex([
      makeFile({ name: "s10.bin", size: 10 }),
      makeFile({ name: "s20.bin", size: 20 }),
      makeFile({ name: "s30.bin", size: 30 }),
      makeFile({ name: "s40.bin", size: 40 }),
      makeFile({ name: "s50.bin", size: 50 }),
    ]);
    const result = await run({ limit: 2 });
    expect(result.count).toBe(2);
    expect(result.results.map(f => f.size)).toEqual([50, 40]);
  });

  it("filters by account", async () => {
    writeIndex([
      makeFile({ name: "alpha1.bin", size: 900, account: "alpha@example.com" }),
      makeFile({ name: "beta1.bin", size: 800, account: "beta@example.com" }),
      makeFile({ name: "alpha2.bin", size: 100, account: "alpha@example.com" }),
    ]);
    const result = await run({ account: "alpha@example.com" });
    expect(result.count).toBe(2);
    expect(result.results.map(f => f.name)).toEqual(["alpha1.bin", "alpha2.bin"]);
    expect(result.results.every(f => f.account === "alpha@example.com")).toBe(true);
  });

  it("filters by root_id", async () => {
    writeIndex([
      makeFile({ name: "onA.bin", size: 400, root_id: "root-a" }),
      makeFile({ name: "onB.bin", size: 700, root_id: "root-b" }),
    ]);
    const result = await run({ root_id: "root-b" });
    expect(result.count).toBe(1);
    expect(result.results[0]!.name).toBe("onB.bin");
  });

  it("filters by extension, normalizing bare and dotted and cased forms", async () => {
    writeIndex([
      makeFile({ name: "report.pdf", size: 500 }),
      makeFile({ name: "photo.png", size: 400 }),
      makeFile({ name: "notes.pdf", size: 300 }),
    ]);

    for (const ext of ["pdf", ".pdf", "PDF", ".PDF"]) {
      const result = await run({ extension: ext });
      expect(result.count).toBe(2);
      expect(result.results.map(f => f.name)).toEqual(["report.pdf", "notes.pdf"]);
    }
  });

  it("combines account, root, and extension filters", async () => {
    writeIndex([
      makeFile({ name: "match.pdf", size: 900, account: "alpha@example.com", root_id: "root-a" }),
      makeFile({ name: "wrongExt.txt", size: 950, account: "alpha@example.com", root_id: "root-a" }),
      makeFile({ name: "wrongRoot.pdf", size: 980, account: "alpha@example.com", root_id: "root-b" }),
      makeFile({ name: "wrongAcct.pdf", size: 990, account: "beta@example.com", root_id: "root-a" }),
    ]);
    const result = await run({ account: "alpha@example.com", root_id: "root-a", extension: "pdf" });
    expect(result.count).toBe(1);
    expect(result.results[0]!.name).toBe("match.pdf");
  });

  it("returns zero count and an empty list for an empty index", async () => {
    writeIndex([]);
    const result = await run({});
    expect(result).toEqual({ count: 0, results: [] });
  });

  it("returns zeros when no index file exists at all", async () => {
    const result = await run({});
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("returns an empty result set when a filter excludes every file", async () => {
    writeIndex([
      makeFile({ name: "a.bin", size: 100, account: "alpha@example.com" }),
      makeFile({ name: "b.bin", size: 200, account: "alpha@example.com" }),
    ]);
    const result = await run({ account: "nobody@example.com" });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});
