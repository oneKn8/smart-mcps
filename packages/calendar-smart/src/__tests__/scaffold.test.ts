import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CalendarClient } from "../client.js";
import { buildContext } from "../context.js";

let savedHome: string | undefined;
let savedIdentity: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedIdentity = process.env.CALENDAR_DEFAULT_IDENTITY;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedIdentity === undefined) delete process.env.CALENDAR_DEFAULT_IDENTITY;
  else process.env.CALENDAR_DEFAULT_IDENTITY = savedIdentity;
});

describe("buildContext — default identity resolution", () => {
  it("defaults account to 'your-account' when CALENDAR_DEFAULT_IDENTITY is unset", () => {
    delete process.env.CALENDAR_DEFAULT_IDENTITY;
    const ctx = buildContext();
    expect(ctx.client).toBeInstanceOf(CalendarClient);
    expect(ctx.client.getAccount()).toBe("your-account");
  });

  it("honors CALENDAR_DEFAULT_IDENTITY env override", () => {
    process.env.CALENDAR_DEFAULT_IDENTITY = "alice";
    const ctx = buildContext();
    expect(ctx.client.getAccount()).toBe("alice");
  });

  it("threads the home override through to the constructor without throwing", () => {
    delete process.env.CALENDAR_DEFAULT_IDENTITY;
    const ctx = buildContext("/tmp/scaffold-home");
    expect(ctx.client).toBeInstanceOf(CalendarClient);
  });
});
