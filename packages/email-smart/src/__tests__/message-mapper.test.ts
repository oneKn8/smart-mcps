import { describe, it, expect } from "vitest";
import { mapMessage, extractBodies } from "../message-mapper.js";

describe("mapMessage", () => {
  it("extracts headers case-insensitively and pulls slim fields", () => {
    const raw = {
      id: "msg_1",
      threadId: "thr_1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello there",
      sizeEstimate: 4321,
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "TO", value: "bob@example.com" },
          { name: "subject", value: "Greetings" },
          { name: "Date", value: "Mon, 28 Apr 2026 12:00:00 +0000" },
        ],
      },
    };

    expect(mapMessage(raw)).toEqual({
      id: "msg_1",
      thread_id: "thr_1",
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Greetings",
      snippet: "Hello there",
      date: "Mon, 28 Apr 2026 12:00:00 +0000",
      labels: ["INBOX", "UNREAD"],
      size_bytes: 4321,
    });
  });

  it("returns empty defaults when headers and labels are absent", () => {
    const raw = {
      id: "msg_2",
      threadId: "thr_2",
      payload: { headers: [] },
    };

    expect(mapMessage(raw)).toEqual({
      id: "msg_2",
      thread_id: "thr_2",
      from: "",
      to: "",
      subject: "",
      snippet: "",
      date: "",
      labels: [],
      size_bytes: 0,
    });
  });

  it("returns exact slim shape — no upstream extras", () => {
    const raw = {
      id: "msg_3",
      threadId: "thr_3",
      labelIds: ["INBOX"],
      snippet: "x",
      sizeEstimate: 10,
      historyId: "12345",
      internalDate: "1700000000000",
      payload: {
        headers: [{ name: "From", value: "x@y.com" }],
        mimeType: "multipart/alternative",
      },
    };

    expect(Object.keys(mapMessage(raw)).sort()).toEqual(
      [
        "date",
        "from",
        "id",
        "labels",
        "size_bytes",
        "snippet",
        "subject",
        "thread_id",
        "to",
      ].sort(),
    );
  });
});

describe("extractBodies", () => {
  function b64url(s: string): string {
    return Buffer.from(s, "utf8").toString("base64url");
  }

  it("decodes single-part text/plain payload from body.data", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: b64url("hello plain") },
    };
    expect(extractBodies(payload)).toEqual({ text: "hello plain" });
  });

  it("decodes single-part text/html payload from body.data", () => {
    const payload = {
      mimeType: "text/html",
      body: { data: b64url("<p>hi</p>") },
    };
    expect(extractBodies(payload)).toEqual({ html: "<p>hi</p>" });
  });

  it("recurses multipart/alternative for both html and text parts", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain body") } },
        { mimeType: "text/html", body: { data: b64url("<b>html body</b>") } },
      ],
    };
    expect(extractBodies(payload)).toEqual({
      text: "plain body",
      html: "<b>html body</b>",
    });
  });

  it("skips attachment parts (filename non-empty)", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("real body") } },
        {
          mimeType: "text/plain",
          filename: "attached.txt",
          body: { data: b64url("attachment content") },
        },
      ],
    };
    expect(extractBodies(payload)).toEqual({ text: "real body" });
  });

  it("recurses into nested multipart trees", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: b64url("nested plain") },
            },
            {
              mimeType: "text/html",
              body: { data: b64url("<i>nested html</i>") },
            },
          ],
        },
        {
          mimeType: "image/png",
          filename: "logo.png",
          body: { attachmentId: "att_1" },
        },
      ],
    };
    expect(extractBodies(payload)).toEqual({
      text: "nested plain",
      html: "<i>nested html</i>",
    });
  });

  it("returns empty object when no decodable bodies are present", () => {
    expect(extractBodies({ mimeType: "image/png", body: {} })).toEqual({});
  });
});
