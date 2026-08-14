import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuthError } from "smart-mcp-core";
import { CalendarClient } from "../client.js";
import { buildContext } from "../context.js";

let savedHome: string | undefined;
let savedIdentity: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedIdentity = process.env.CALENDAR_DEFAULT_IDENTITY;
  // Isolate from the real ~/.config/smart-mcps/.env so the shared file can
  // never satisfy (or fail to satisfy) the identity requirement for us.
  process.env.HOME = "/nonexistent-calendar-smart-test-home";
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedIdentity === undefined) delete process.env.CALENDAR_DEFAULT_IDENTITY;
  else process.env.CALENDAR_DEFAULT_IDENTITY = savedIdentity;
});

describe("buildContext — identity resolution", () => {
  it("throws AuthError when CALENDAR_DEFAULT_IDENTITY is unset", () => {
    delete process.env.CALENDAR_DEFAULT_IDENTITY;
    expect(() => buildContext()).toThrow(AuthError);
  });

  it("honors CALENDAR_DEFAULT_IDENTITY env override", () => {
    process.env.CALENDAR_DEFAULT_IDENTITY = "alice";
    const ctx = buildContext();
    expect(ctx.client).toBeInstanceOf(CalendarClient);
    expect(ctx.client.getAccount()).toBe("alice");
  });

  it("threads the home override through to the constructor without throwing", () => {
    process.env.CALENDAR_DEFAULT_IDENTITY = "alice";
    const ctx = buildContext("/tmp/scaffold-home");
    expect(ctx.client).toBeInstanceOf(CalendarClient);
  });
});
