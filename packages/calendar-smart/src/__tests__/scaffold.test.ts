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

describe("CalendarClient — constructor skeleton", () => {
  it("constructor is side-effect-free (does not throw without HOME or token)", () => {
    delete process.env.HOME;
    expect(() => new CalendarClient("alice")).not.toThrow();
  });

  it("getAccount returns the account passed to the constructor", () => {
    const client = new CalendarClient("alice");
    expect(client.getAccount()).toBe("alice");
  });

  it("cachedTimeZone is undefined on a fresh client", () => {
    const client = new CalendarClient("alice");
    expect(client.getCachedTimeZone()).toBeUndefined();
  });

  it("opts.home and opts.oauthClient round-trip via getOpts", () => {
    const stub = { marker: "fake-oauth" };
    const client = new CalendarClient("alice", {
      home: "/tmp/fake",
      oauthClient: stub,
    });
    const opts = client.getOpts();
    expect(opts.home).toBe("/tmp/fake");
    expect(opts.oauthClient).toBe(stub);
  });

  it("exposes static TOKEN_FILE_SUFFIX = '.calendar.json'", () => {
    expect(CalendarClient.TOKEN_FILE_SUFFIX).toBe(".calendar.json");
  });

  it("exposes static REQUIRED_SCOPE = Google calendar scope", () => {
    expect(CalendarClient.REQUIRED_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar",
    );
  });
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

  it("threads the home override through to the client opts", () => {
    delete process.env.CALENDAR_DEFAULT_IDENTITY;
    const ctx = buildContext("/tmp/scaffold-home");
    expect(ctx.client.getOpts().home).toBe("/tmp/scaffold-home");
  });
});
