import { describe, it, expect } from "vitest";
import { buildRawMessage } from "../mime.js";
import type { Identity } from "../identities.js";

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}

function makeIdentity(over: Partial<Identity> = {}): Identity {
  return {
    account: "alice",
    email: "alice@example.com",
    display_name: "Alice Example",
    transport: "oauth",
    ...over,
  };
}

function getHeader(msg: string, name: string): string | undefined {
  const headerBlock = msg.split("\r\n\r\n", 1)[0]!;
  // Unfold continuations: a line starting with whitespace continues the prior header.
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, " ");
  const lines = unfolded.split("\r\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.toLowerCase() === name.toLowerCase()) {
      return line.slice(idx + 1).trim();
    }
  }
  return undefined;
}

describe("buildRawMessage", () => {
  it('From header is "Display Name <email>" formataddr shape', () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
    const msg = decodeBase64Url(raw);
    const from = getHeader(msg, "From");
    expect(from).toBe("Alice Example <alice@example.com>");
  });

  it("Subject is RFC 2047 base64-encoded when non-ASCII", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "Привет",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    const subject = getHeader(msg, "Subject");
    expect(subject).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // Decode and check round-trip.
    const m = subject!.match(/^=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
    expect(decoded).toBe("Привет");
  });

  it("Subject is plain (not encoded) when ASCII-only", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "Plain ASCII subject",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Subject")).toBe("Plain ASCII subject");
  });

  it("multipart/alternative with plaintext FIRST, HTML SECOND", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>HTMLBODYMARKER</p>",
      text: "TEXTBODYMARKER",
    });
    const msg = decodeBase64Url(raw);
    const ctype = getHeader(msg, "Content-Type");
    expect(ctype).toContain("multipart/alternative");
    const boundaryMatch = ctype!.match(/boundary="?([^";]+)"?/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;
    const idxText = msg.indexOf("TEXTBODYMARKER");
    const idxHtml = msg.indexOf("HTMLBODYMARKER");
    expect(idxText).toBeGreaterThan(0);
    expect(idxHtml).toBeGreaterThan(0);
    expect(idxText).toBeLessThan(idxHtml);
    expect(msg).toContain(`--${boundary}`);
    expect(msg).toContain(`--${boundary}--`);
    // The plain part declares text/plain BEFORE the html part declares text/html.
    const plainPos = msg.indexOf("text/plain");
    const htmlPos = msg.indexOf("text/html");
    expect(plainPos).toBeGreaterThan(0);
    expect(htmlPos).toBeGreaterThan(plainPos);
  });

  it("Reply-To uses opts.reply_to when provided", () => {
    const raw = buildRawMessage({
      identity: makeIdentity({ default_reply_to: "default@example.com" }),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      reply_to: "explicit@example.com",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Reply-To")).toBe("explicit@example.com");
  });

  it("Reply-To falls back to identity.default_reply_to when opts.reply_to missing", () => {
    const raw = buildRawMessage({
      identity: makeIdentity({ default_reply_to: "default@example.com" }),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Reply-To")).toBe("default@example.com");
  });

  it("Reply-To falls back to identity.email when no default_reply_to and no opts.reply_to", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Reply-To")).toBe("alice@example.com");
  });

  it("Date header is RFC 5322 / 2822 format", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    const date = getHeader(msg, "Date");
    expect(date).toBeDefined();
    // Date.parse on toUTCString output round-trips.
    expect(Number.isNaN(Date.parse(date!))).toBe(false);
    // RFC 5322 day-of-week + comma + day + month + year + time + zone.
    expect(date!).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} (GMT|[+-]\d{4})$/,
    );
  });

  it("Message-ID is <uuid@<domain-from-email>>", () => {
    const raw = buildRawMessage({
      identity: makeIdentity({ email: "alice@some.host.tld" }),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    const id = getHeader(msg, "Message-ID");
    expect(id).toBeDefined();
    expect(id!).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@some\.host\.tld>$/i,
    );
  });

  it("default headers are always set", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Auto-Submitted")).toBe("no");
    expect(getHeader(msg, "X-Mailer")).toBe(
      "santo-mailer/1.0 (on behalf of Alice Example)",
    );
    expect(getHeader(msg, "X-Sent-By-Agent")).toBe("smart-mcps-email/1.0");
    expect(getHeader(msg, "X-Agent-Operator")).toBe("alice@example.com");
  });

  it("custom headers map overrides defaults", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      headers: {
        "X-Sent-By-Agent": "custom-agent/9.9",
        "X-Custom-Tag": "demo",
      },
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "X-Sent-By-Agent")).toBe("custom-agent/9.9");
    expect(getHeader(msg, "X-Custom-Tag")).toBe("demo");
    // A non-overridden default still present.
    expect(getHeader(msg, "Auto-Submitted")).toBe("no");
  });

  it("CC and BCC absent when not provided", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Cc")).toBeUndefined();
    expect(getHeader(msg, "Bcc")).toBeUndefined();
  });

  it("CC and BCC present when provided", () => {
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    expect(getHeader(msg, "Cc")).toBe("cc@example.com");
    expect(getHeader(msg, "Bcc")).toBe("bcc@example.com");
  });

  it("output is base64url: no '=' padding, no '+' or '/'", () => {
    // Use a payload large enough that base64-standard would normally include
    // every troublesome character class.
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: `<p>${"x".repeat(500)}</p>`,
      text: "x".repeat(500),
    });
    expect(raw).not.toContain("=");
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
