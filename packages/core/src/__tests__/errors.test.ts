import { describe, it, expect } from "vitest";
import {
  SmartMcpError,
  AuthError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  ConfirmRequiredError,
  UpstreamError,
  AmbiguousMatchError,
  toMcpResult,
} from "../errors.js";

describe("SmartMcpError", () => {
  it("base class carries name, message, recovery, detail", () => {
    const err = new SmartMcpError("base", "something broke", {
      recovery: "try again",
      detail: { foo: 1 },
    });
    expect(err.name).toBe("SmartMcpError");
    expect(err.code).toBe("base");
    expect(err.message).toBe("something broke");
    expect(err.recovery).toBe("try again");
    expect(err.detail).toEqual({ foo: 1 });
  });

  it("subclasses set their own code", () => {
    expect(new AuthError("x").code).toBe("AUTH");
    expect(new RateLimitError("x", { retryAfterSec: 30 }).code).toBe("RATE_LIMIT");
    expect(new NotFoundError("x").code).toBe("NOT_FOUND");
    expect(new ValidationError("x").code).toBe("VALIDATION");
    expect(new ConfirmRequiredError("x", { preview: "p" }).code).toBe("CONFIRM_REQUIRED");
    expect(new UpstreamError("x").code).toBe("UPSTREAM");
    expect(new AmbiguousMatchError("x", { candidates: [] }).code).toBe("AMBIGUOUS_MATCH");
  });

  it("RateLimitError exposes retryAfterSec", () => {
    const err = new RateLimitError("rate-limited", { retryAfterSec: 47 });
    expect(err.retryAfterSec).toBe(47);
  });

  it("ConfirmRequiredError exposes preview", () => {
    const err = new ConfirmRequiredError("confirm needed", { preview: "Will delete X" });
    expect(err.preview).toBe("Will delete X");
  });

  it("AmbiguousMatchError exposes candidates", () => {
    const err = new AmbiguousMatchError("multiple matches", {
      candidates: [{ score: 0.9, label: "alpha-team-com" }],
    });
    expect(err.candidates).toHaveLength(1);
  });
});

describe("toMcpResult", () => {
  it("formats SmartMcpError as MCP error result with rewritten leading line + raw detail", () => {
    const err = new AuthError("Vercel rejected the token", {
      recovery: "Check VERCEL_TOKEN is valid",
      detail: { upstream: "401: token_invalid" },
    });
    const result = toMcpResult(err);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Vercel rejected the token");
    expect(text).toContain("Check VERCEL_TOKEN is valid");
    expect(text).toContain("401: token_invalid");
    expect(text).toContain("AUTH");
  });

  it("wraps unknown errors as UPSTREAM", () => {
    const result = toMcpResult(new Error("totally unexpected"));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("UPSTREAM");
    expect(text).toContain("totally unexpected");
  });

  it("does not throw when detail is a cyclic object", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() =>
      toMcpResult(new UpstreamError("oops", { detail: cyclic })),
    ).not.toThrow();
  });

  it("falls back to String(detail) when JSON.stringify returns undefined", () => {
    const result = toMcpResult(new UpstreamError("fn detail", { detail: () => 1 }));
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Detail:");
    // String(() => 1) yields the function source
    expect(text).toMatch(/Detail: .*=>/);
  });
});
