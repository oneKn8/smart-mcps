import { describe, it, expect } from "vitest";
import {
  buildRawMessageWithAttachments,
  type AttachmentPart,
} from "../mime.js";
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

describe("buildRawMessageWithAttachments", () => {
  it("outer Content-Type is multipart/mixed with a boundary", () => {
    const att: AttachmentPart = {
      filename: "a.txt",
      content_type: "text/plain; charset=utf-8",
      bytes: Buffer.from("hello"),
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    const ctype = getHeader(msg, "Content-Type");
    expect(ctype).toContain("multipart/mixed");
    const boundaryMatch = ctype!.match(/boundary="?([^";]+)"?/);
    expect(boundaryMatch).not.toBeNull();
    const outerBoundary = boundaryMatch![1]!;
    expect(msg).toContain(`--${outerBoundary}`);
    expect(msg).toContain(`--${outerBoundary}--`);
  });

  it("inner alternative present with plaintext-first-html-second order", () => {
    const att: AttachmentPart = {
      filename: "a.txt",
      content_type: "text/plain; charset=utf-8",
      bytes: Buffer.from("hello"),
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>HTMLBODYMARKER</p>",
      text: "TEXTBODYMARKER",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    expect(msg).toContain("multipart/alternative");
    const idxText = msg.indexOf("TEXTBODYMARKER");
    const idxHtml = msg.indexOf("HTMLBODYMARKER");
    expect(idxText).toBeGreaterThan(0);
    expect(idxHtml).toBeGreaterThan(0);
    expect(idxText).toBeLessThan(idxHtml);
  });

  it("attachment part has correct Content-Type, Content-Disposition, Content-Transfer-Encoding", () => {
    const att: AttachmentPart = {
      filename: "report.pdf",
      content_type: "application/pdf",
      bytes: Buffer.from("FAKEPDF"),
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    expect(msg).toContain("Content-Type: application/pdf");
    expect(msg).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(msg).toContain("Content-Transfer-Encoding: base64");
  });

  it("multiple attachments produce N attachment parts", () => {
    const atts: AttachmentPart[] = [
      {
        filename: "one.txt",
        content_type: "text/plain; charset=utf-8",
        bytes: Buffer.from("aaa"),
      },
      {
        filename: "two.png",
        content_type: "image/png",
        bytes: Buffer.from("bbb"),
      },
      {
        filename: "three.json",
        content_type: "application/json; charset=utf-8",
        bytes: Buffer.from("{}"),
      },
    ];
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: atts,
    });
    const msg = decodeBase64Url(raw);
    expect(msg).toContain('filename="one.txt"');
    expect(msg).toContain('filename="two.png"');
    expect(msg).toContain('filename="three.json"');
    // Three Content-Disposition: attachment headers, one per attachment.
    const dispositions = msg.match(/Content-Disposition: attachment;/g) ?? [];
    expect(dispositions).toHaveLength(3);
  });

  it("output is base64url (no '=' padding, '+' or '/')", () => {
    const att: AttachmentPart = {
      filename: "a.bin",
      content_type: "application/octet-stream",
      bytes: Buffer.from("x".repeat(500)),
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    expect(raw).not.toContain("=");
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("base64-encoded attachment body is line-broken every 76 chars (RFC 2045)", () => {
    // 200 byte payload guarantees multi-line base64 (~268 chars b64).
    const payload = Buffer.alloc(200, 0x41); // 'A' * 200
    const att: AttachmentPart = {
      filename: "big.bin",
      content_type: "application/octet-stream",
      bytes: payload,
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    // Find the attachment body section: it starts after the attachment headers
    // (after the blank \r\n\r\n following Content-Transfer-Encoding) and ends
    // at the next "--<boundary>" line. Each non-final base64 line should be
    // <= 76 chars.
    const tag = "Content-Transfer-Encoding: base64";
    const start = msg.indexOf(tag);
    expect(start).toBeGreaterThan(-1);
    const bodyStart = msg.indexOf("\r\n\r\n", start) + 4;
    const bodyEnd = msg.indexOf("\r\n--", bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = msg.slice(bodyStart, bodyEnd);
    const lines = body.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("attachment body decodes back to the original bytes", () => {
    const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
    const att: AttachmentPart = {
      filename: "fox.txt",
      content_type: "text/plain; charset=utf-8",
      bytes: payload,
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    const tag = "Content-Transfer-Encoding: base64";
    const start = msg.indexOf(tag);
    const bodyStart = msg.indexOf("\r\n\r\n", start) + 4;
    const bodyEnd = msg.indexOf("\r\n--", bodyStart);
    const body = msg.slice(bodyStart, bodyEnd);
    const compact = body.replace(/\r\n/g, "");
    expect(Buffer.from(compact, "base64").toString("utf-8")).toBe(
      "the quick brown fox jumps over the lazy dog",
    );
  });

  it("top-level headers (From/To/Subject) live on the OUTER multipart/mixed, not on the inner alternative", () => {
    const att: AttachmentPart = {
      filename: "a.txt",
      content_type: "text/plain; charset=utf-8",
      bytes: Buffer.from("x"),
    };
    const raw = buildRawMessageWithAttachments({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
      attachments: [att],
    });
    const msg = decodeBase64Url(raw);
    // From/To/Subject live in the FIRST header block (before the first \r\n\r\n).
    const firstBlock = msg.split("\r\n\r\n", 1)[0]!;
    expect(firstBlock).toContain("From: Alice Example <alice@example.com>");
    expect(firstBlock).toContain("To: to@example.com");
    expect(firstBlock).toContain("Subject: S");
    expect(firstBlock).toContain("multipart/mixed");
    expect(firstBlock).not.toContain("multipart/alternative");
  });

  it("buildRawMessage (no attachments) still produces multipart/alternative outer (backwards compat)", async () => {
    const { buildRawMessage } = await import("../mime.js");
    const raw = buildRawMessage({
      identity: makeIdentity(),
      to: "to@example.com",
      subject: "S",
      html: "<p>x</p>",
      text: "x",
    });
    const msg = decodeBase64Url(raw);
    const ctype = getHeader(msg, "Content-Type");
    expect(ctype).toContain("multipart/alternative");
    expect(ctype).not.toContain("multipart/mixed");
  });
});
