import { describe, it, expect } from "vitest";
import {
  mapContent,
  mapFile,
  toFileWritePayload,
} from "../content-mapper.js";

describe("mapFile", () => {
  it("keeps only name/type/source, dropping read-only fields", () => {
    const out = mapFile({
      name: "Code",
      type: "SERVER_JS",
      source: "function f(){}",
      lastModifyUser: { email: "x" },
      createTime: "t",
      updateTime: "t2",
      functionSet: { values: [{ name: "f" }] },
    });
    expect(out).toEqual({
      name: "Code",
      type: "SERVER_JS",
      source: "function f(){}",
    });
  });

  it("source collapses to null when absent", () => {
    expect(mapFile({ name: "appsscript", type: "JSON" })).toEqual({
      name: "appsscript",
      type: "JSON",
      source: null,
    });
  });
});

describe("mapContent", () => {
  it("maps scriptId + files and normalizes a missing files array to []", () => {
    expect(mapContent({ scriptId: "s1" })).toEqual({
      script_id: "s1",
      files: [],
    });
  });

  it("maps each file through mapFile", () => {
    const out = mapContent({
      scriptId: "s1",
      files: [
        { name: "Code", type: "SERVER_JS", source: "a" },
        { name: "appsscript", type: "JSON", source: "{}" },
      ],
    });
    expect(out).toEqual({
      script_id: "s1",
      files: [
        { name: "Code", type: "SERVER_JS", source: "a" },
        { name: "appsscript", type: "JSON", source: "{}" },
      ],
    });
  });
});

describe("toFileWritePayload", () => {
  it("reduces a raw file to the writable triple with empty-string source default", () => {
    expect(
      toFileWritePayload({
        name: "appsscript",
        type: "JSON",
        source: "{}",
        updateTime: "ignored",
      }),
    ).toEqual({ name: "appsscript", type: "JSON", source: "{}" });
    expect(toFileWritePayload({ name: "Empty", type: "HTML" })).toEqual({
      name: "Empty",
      type: "HTML",
      source: "",
    });
  });
});
