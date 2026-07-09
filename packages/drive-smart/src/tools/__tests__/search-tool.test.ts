import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext, type DriveContext } from "../../context.js";
import { driveSearch } from "../search.js";
import type { IndexedFile } from "../../types.js";

const SLIM_FILE_KEYS = ["id", "name", "path", "account", "size", "size_human", "extension"];
const SLIM_FILE_KEYS_NO_ACCOUNT = ["id", "name", "path", "size", "size_human", "extension"];
const LEAK_KEYS = ["root_id", "root_label", "relative_path", "modified_ms", "kind"];

let tmp: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-smart-search-"));
  stateDir = path.join(tmp, ".santo-agent", "drive-smart");
  fs.mkdirSync(stateDir, { recursive: true });
  // gvfsBase points at an empty temp dir, never a real mount.
  fs.mkdirSync(path.join(tmp, "empty-gvfs"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  const base: IndexedFile = {
    id: "root-a:file",
    root_id: "root-a",
    root_label: "Root A",
    account: "alpha@gmail.com",
    path: "/mnt/a/file",
    relative_path: "file",
    name: "file",
    extension: "",
    size: 100,
    modified_ms: 1000,
    kind: "file",
  };
  return { ...base, ...overrides };
}

function writeIndex(files: IndexedFile[]): void {
  const index = {
    version: 1 as const,
    generated_at: "2026-05-26T12:00:00.000Z",
    roots: [],
    files,
    skipped: [],
  };
  fs.writeFileSync(path.join(stateDir, "index.json"), JSON.stringify(index, null, 2));
}

function ctx(): DriveContext {
  return buildContext({ home: tmp, gvfsBase: path.join(tmp, "empty-gvfs") });
}

async function run(input: unknown) {
  return driveSearch.handler(driveSearch.inputSchema.parse(input), ctx());
}

// A small, reusable corpus. q="report" matches:
//   report_pdf (name)        size 5000  .pdf  alpha  root-a
//   report_in_path (path)    size  700  .bin  alpha  root-a
//   tiny_report (name)       size   10  .pdf  beta   root-b
// and never matches slides_pdf or notes_txt.
function corpus(): IndexedFile[] {
  return [
    makeFile({
      id: "root-a:Report.pdf",
      name: "Report.pdf",
      path: "/mnt/a/Report.pdf",
      relative_path: "Report.pdf",
      extension: ".pdf",
      size: 5000,
      account: "alpha@gmail.com",
      root_id: "root-a",
    }),
    makeFile({
      id: "root-a:report-folder/data.bin",
      name: "data.bin",
      path: "/mnt/a/report-folder/data.bin",
      relative_path: "report-folder/data.bin",
      extension: ".bin",
      size: 700,
      account: "alpha@gmail.com",
      root_id: "root-a",
    }),
    makeFile({
      id: "root-b:old_report.pdf",
      name: "old_report.pdf",
      path: "/mnt/b/old_report.pdf",
      relative_path: "old_report.pdf",
      extension: ".pdf",
      size: 10,
      account: "beta@gmail.com",
      root_id: "root-b",
    }),
    makeFile({
      id: "root-b:Slides.pdf",
      name: "Slides.pdf",
      path: "/mnt/b/Slides.pdf",
      relative_path: "Slides.pdf",
      extension: ".pdf",
      size: 50000,
      account: "beta@gmail.com",
      root_id: "root-b",
    }),
    makeFile({
      id: "root-a:notes.txt",
      name: "notes.txt",
      path: "/mnt/a/notes.txt",
      relative_path: "notes.txt",
      extension: ".txt",
      size: 300,
      account: "alpha@gmail.com",
      root_id: "root-a",
    }),
  ];
}

describe("drive_search metadata", () => {
  it("is named exactly drive_search", () => {
    expect(driveSearch.name).toBe("drive_search");
  });

  it("has a non-empty string description", () => {
    expect(typeof driveSearch.description).toBe("string");
    expect(driveSearch.description.length).toBeGreaterThan(0);
  });
});

describe("drive_search schema", () => {
  it("rejects clearly-invalid input", () => {
    // Missing required q.
    expect(() => driveSearch.inputSchema.parse({})).toThrow();
    // Empty q (min 1).
    expect(() => driveSearch.inputSchema.parse({ q: "" })).toThrow();
    // max_results below/above bounds.
    expect(() => driveSearch.inputSchema.parse({ q: "a", max_results: 0 })).toThrow();
    expect(() => driveSearch.inputSchema.parse({ q: "a", max_results: 501 })).toThrow();
    // Negative min_size.
    expect(() => driveSearch.inputSchema.parse({ q: "a", min_size: -1 })).toThrow();
  });

  it("resolves documented defaults on a minimal valid input", () => {
    // q is required for this tool, so the minimal valid input carries only q;
    // max_results defaults to 50 and the optional filters stay undefined.
    const parsed = driveSearch.inputSchema.parse({ q: "x" });
    expect(parsed.max_results).toBe(50);
    expect(parsed.account).toBeUndefined();
    expect(parsed.root_id).toBeUndefined();
    expect(parsed.extension).toBeUndefined();
    expect(parsed.min_size).toBeUndefined();
  });
});

describe("drive_search output shape", () => {
  it("returns exactly count and results at the top level", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report" });
    expect(Object.keys(result).sort()).toEqual(["count", "results"].sort());
    expect(result.count).toBe(result.results.length);
  });

  it("strips indexed files down to the SlimFile shape (no leak of bookkeeping fields)", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report" });
    // Largest match first: Report.pdf carries an account.
    const top = result.results[0]!;
    expect(Object.keys(top).sort()).toEqual(SLIM_FILE_KEYS.sort());
    for (const leaked of LEAK_KEYS) {
      expect(top).not.toHaveProperty(leaked);
    }
    expect(typeof top.size_human).toBe("string");
  });

  it("omits account when the indexed file has none", async () => {
    writeIndex([
      makeFile({
        id: "root-c:report_noacct.md",
        name: "report_noacct.md",
        path: "/mnt/c/report_noacct.md",
        relative_path: "report_noacct.md",
        extension: ".md",
        size: 42,
        account: undefined,
        root_id: "root-c",
      }),
    ]);
    const result = await run({ q: "report" });
    expect(result.count).toBe(1);
    expect(Object.keys(result.results[0]!).sort()).toEqual(SLIM_FILE_KEYS_NO_ACCOUNT.sort());
    expect(result.results[0]).not.toHaveProperty("account");
  });
});

describe("drive_search matching and ordering", () => {
  it("matches on name or path and sorts results descending by size", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report" });
    expect(result.count).toBe(3);
    expect(result.results.map(f => f.name)).toEqual([
      "Report.pdf", // 5000, name match
      "data.bin", // 700, path match only
      "old_report.pdf", // 10, name match
    ]);
    expect(result.results.map(f => f.size)).toEqual([5000, 700, 10]);
  });

  it("matches case-insensitively", async () => {
    writeIndex(corpus());
    const upper = await run({ q: "REPORT" });
    const lower = await run({ q: "report" });
    expect(upper.count).toBe(3);
    expect(upper.results.map(f => f.id)).toEqual(lower.results.map(f => f.id));
  });
});

describe("drive_search filters", () => {
  it("normalizes extension with or without a leading dot", async () => {
    writeIndex(corpus());
    const withDot = await run({ q: "report", extension: ".pdf" });
    const withoutDot = await run({ q: "report", extension: "pdf" });
    expect(withDot.results.map(f => f.name)).toEqual(["Report.pdf", "old_report.pdf"]);
    expect(withoutDot.results.map(f => f.name)).toEqual(withDot.results.map(f => f.name));
  });

  it("filters by account", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report", account: "beta@gmail.com" });
    expect(result.count).toBe(1);
    expect(result.results[0]!.name).toBe("old_report.pdf");
  });

  it("filters by root_id", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report", root_id: "root-a" });
    expect(result.count).toBe(2);
    expect(result.results.map(f => f.name)).toEqual(["Report.pdf", "data.bin"]);
  });

  it("filters by min_size", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report", min_size: 1000 });
    expect(result.count).toBe(1);
    expect(result.results[0]!.name).toBe("Report.pdf");
  });

  it("caps results at max_results, keeping the largest", async () => {
    writeIndex(corpus());
    const result = await run({ q: "report", max_results: 1 });
    expect(result.count).toBe(1);
    expect(result.results[0]!.name).toBe("Report.pdf");
  });
});

describe("drive_search edge cases", () => {
  it("returns zero for an empty index", async () => {
    writeIndex([]);
    const result = await run({ q: "report" });
    expect(result).toEqual({ count: 0, results: [] });
  });

  it("returns zero when nothing matches the query", async () => {
    writeIndex(corpus());
    const result = await run({ q: "no-such-token-xyz" });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("returns an empty result when no index file exists yet", async () => {
    // No index.json written; loadIndex falls back to an empty index.
    const result = await run({ q: "report" });
    expect(result).toEqual({ count: 0, results: [] });
  });
});
