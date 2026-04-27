import { describe, it, expect } from "vitest";
import { guardDestructive } from "../confirm.js";
import { ConfirmRequiredError } from "../errors.js";

describe("guardDestructive", () => {
  it("throws ConfirmRequiredError when confirm is false", () => {
    expect(() =>
      guardDestructive({ confirm: false, preview: "Will delete X" }),
    ).toThrowError(ConfirmRequiredError);
  });

  it("throws ConfirmRequiredError when confirm is undefined", () => {
    expect(() =>
      guardDestructive({ confirm: undefined as unknown as boolean, preview: "preview" }),
    ).toThrowError(ConfirmRequiredError);
  });

  it("includes preview in the thrown error", () => {
    try {
      guardDestructive({ confirm: false, preview: "Will delete env var FOO from project bar" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe("Will delete env var FOO from project bar");
    }
  });

  it("returns silently when confirm is true", () => {
    expect(() =>
      guardDestructive({ confirm: true, preview: "preview" }),
    ).not.toThrow();
  });
});
