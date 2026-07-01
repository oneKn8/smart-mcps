import { describe, it, expect } from "vitest";
import { mapFile, type SlimFile } from "../file-mapper.js";

const SLIM_KEYS: ReadonlyArray<keyof SlimFile> = [
  "id",
  "name",
  "mime_type",
  "parents",
  "web_view_link",
  "trashed",
  "starred",
  "size",
  "modified_time",
];

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "file_alpha",
    name: "Q3 report.pdf",
    mimeType: "application/pdf",
    parents: ["folder_beta"],
    webViewLink: "https://drive.google.com/file/d/file_alpha/view",
    trashed: false,
    starred: false,
    size: "1048576",
    modifiedTime: "2026-06-30T12:00:00.000Z",
    ...over,
  };
}

describe("mapFile — basics", () => {
  it("maps a typical file resource to the slim snake_case shape", () => {
    expect(mapFile(fixture())).toEqual({
      id: "file_alpha",
      name: "Q3 report.pdf",
      mime_type: "application/pdf",
      parents: ["folder_beta"],
      web_view_link: "https://drive.google.com/file/d/file_alpha/view",
      trashed: false,
      starred: false,
      size: "1048576",
      modified_time: "2026-06-30T12:00:00.000Z",
    });
  });

  it("preserves trashed/starred booleans", () => {
    const slim = mapFile(fixture({ trashed: true, starred: true }));
    expect(slim.trashed).toBe(true);
    expect(slim.starred).toBe(true);
  });
});

describe("mapFile — missing / malformed fields", () => {
  it("missing id/name/mimeType degrade to empty strings", () => {
    const fx = fixture();
    delete (fx as Record<string, unknown>).id;
    delete (fx as Record<string, unknown>).name;
    delete (fx as Record<string, unknown>).mimeType;
    const slim = mapFile(fx);
    expect(slim.id).toBe("");
    expect(slim.name).toBe("");
    expect(slim.mime_type).toBe("");
  });

  it("missing parents collapses to an empty array", () => {
    const fx = fixture();
    delete (fx as Record<string, unknown>).parents;
    expect(mapFile(fx).parents).toEqual([]);
  });

  it("filters non-string entries out of parents", () => {
    const slim = mapFile(fixture({ parents: ["p1", 42, null, "p2"] }));
    expect(slim.parents).toEqual(["p1", "p2"]);
  });

  it("missing webViewLink/size/modifiedTime collapse to null", () => {
    const fx = fixture();
    delete (fx as Record<string, unknown>).webViewLink;
    delete (fx as Record<string, unknown>).size;
    delete (fx as Record<string, unknown>).modifiedTime;
    const slim = mapFile(fx);
    expect(slim.web_view_link).toBeNull();
    expect(slim.size).toBeNull();
    expect(slim.modified_time).toBeNull();
  });

  it("absent trashed/starred default to false", () => {
    const fx = fixture();
    delete (fx as Record<string, unknown>).trashed;
    delete (fx as Record<string, unknown>).starred;
    const slim = mapFile(fx);
    expect(slim.trashed).toBe(false);
    expect(slim.starred).toBe(false);
  });

  it("keeps size as a string (Drive int64 format)", () => {
    const slim = mapFile(fixture({ size: "2000" }));
    expect(slim.size).toBe("2000");
  });

  it("non-string size degrades to null (never a number)", () => {
    const slim = mapFile(fixture({ size: 2000 }));
    expect(slim.size).toBeNull();
  });
});

describe("mapFile — error handling", () => {
  it("throws when given a non-object", () => {
    expect(() => mapFile(null)).toThrow();
    expect(() => mapFile(42)).toThrow();
    expect(() => mapFile([])).toThrow();
  });
});

describe("mapFile — field stripping", () => {
  it("returns exactly the 9 SlimFile keys (no upstream noise)", () => {
    const slim = mapFile({
      // Upstream noise that must NOT appear on the slim shape.
      kind: "drive#file",
      etag: "etag-abc",
      md5Checksum: "deadbeef",
      owners: [{ displayName: "Santo", emailAddress: "s@example.test" }],
      shortcutDetails: { targetId: "t" },
      capabilities: { canEdit: true },
      id: "file_alpha",
      name: "x",
      mimeType: "text/plain",
    });
    expect(Object.keys(slim).sort()).toEqual([...SLIM_KEYS].sort());
  });
});
