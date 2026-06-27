import { describe, it, expect } from "vitest";
import { ValidationError } from "smart-mcp-core";
import { parseSpreadsheetId, quoteSheetTitle } from "../sheet-ref.js";

describe("parseSpreadsheetId", () => {
  it("returns a bare id unchanged", () => {
    expect(parseSpreadsheetId("1AbC_xyz-123")).toBe("1AbC_xyz-123");
  });

  it("extracts the id from a full docs.google.com URL", () => {
    expect(
      parseSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1AbC_xyz-123/edit#gid=0",
      ),
    ).toBe("1AbC_xyz-123");
  });

  it("extracts the id from a URL without an edit suffix", () => {
    expect(
      parseSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1RealLongId_aB-cD",
      ),
    ).toBe("1RealLongId_aB-cD");
  });

  it("throws ValidationError on junk input", () => {
    expect(() => parseSpreadsheetId("not a url")).toThrow(ValidationError);
  });

  it("throws ValidationError on an empty string", () => {
    expect(() => parseSpreadsheetId("")).toThrow(ValidationError);
  });
});

describe("quoteSheetTitle", () => {
  it("quotes a title containing spaces", () => {
    expect(quoteSheetTitle("My Sheet")).toBe("'My Sheet'");
  });

  it("leaves a plain alphanumeric title unquoted", () => {
    expect(quoteSheetTitle("Plain")).toBe("Plain");
  });

  it("doubles an embedded apostrophe and wraps", () => {
    expect(quoteSheetTitle("Jon's")).toBe("'Jon''s'");
  });

  it("leaves an underscore-only title unquoted", () => {
    expect(quoteSheetTitle("Loan_Ledger")).toBe("Loan_Ledger");
  });
});
