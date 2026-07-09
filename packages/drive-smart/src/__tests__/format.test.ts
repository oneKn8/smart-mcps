import { describe, expect, it } from "vitest";
import { bytes, compactFile } from "../format.js";

describe("bytes", () => {
  it("formats byte values without decimals", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(42)).toBe("42 B");
    expect(bytes(1023)).toBe("1023 B");
  });

  it("formats larger units with one decimal", () => {
    expect(bytes(1024)).toBe("1.0 KB");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(1024 * 1024)).toBe("1.0 MB");
    expect(bytes(1024 ** 3 * 2.25)).toBe("2.3 GB");
  });

  it("stops at terabytes for very large values", () => {
    expect(bytes(1024 ** 5)).toBe("1024.0 TB");
  });
});

describe("compactFile", () => {
  it("preserves file fields and adds size_human", () => {
    const file = {
      id: "root:file.txt",
      name: "file.txt",
      size: 2048,
    };

    expect(compactFile(file)).toEqual({
      id: "root:file.txt",
      name: "file.txt",
      size: 2048,
      size_human: "2.0 KB",
    });
  });
});
