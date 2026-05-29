import { describe, it, expect } from "vitest";
import { mapChannel } from "../channel-mapper.js";
import { mapMessage } from "../message-mapper.js";

// ---------------------------------------------------------------------------
// mapChannel
// ---------------------------------------------------------------------------

describe("mapChannel — public channel", () => {
  const raw = {
    id: "C001",
    name: "general",
    is_private: false,
    is_im: false,
    is_mpim: false,
    is_archived: false,
    is_member: true,
    num_members: 15,
    topic: { value: "Team updates", creator: "U001", last_set: 1234567890 },
    purpose: { value: "General chat", creator: "U001", last_set: 1234567890 },
    extra_field: "should_be_stripped",
  };

  it("maps required fields correctly", () => {
    const slim = mapChannel(raw);
    expect(slim.id).toBe("C001");
    expect(slim.name).toBe("general");
    expect(slim.is_private).toBe(false);
    expect(slim.is_im).toBe(false);
    expect(slim.is_mpim).toBe(false);
    expect(slim.is_archived).toBe(false);
  });

  it("includes is_member and num_members when present", () => {
    const slim = mapChannel(raw);
    expect(slim.is_member).toBe(true);
    expect(slim.num_members).toBe(15);
  });

  it("extracts topic.value and purpose.value", () => {
    const slim = mapChannel(raw);
    expect(slim.topic).toBe("Team updates");
    expect(slim.purpose).toBe("General chat");
  });

  it("does not include user field (not an IM)", () => {
    const slim = mapChannel(raw);
    expect(slim).not.toHaveProperty("user");
  });

  it("does not include upstream extras like extra_field", () => {
    const slim = mapChannel(raw);
    expect(slim).not.toHaveProperty("extra_field");
  });
});

describe("mapChannel — private channel", () => {
  const raw = {
    id: "C002",
    name: "secret",
    is_private: true,
    is_im: false,
    is_mpim: false,
    is_archived: false,
  };

  it("sets is_private=true", () => {
    const slim = mapChannel(raw);
    expect(slim.is_private).toBe(true);
  });

  it("omits topic, purpose, is_member, num_members when absent", () => {
    const slim = mapChannel(raw);
    expect(slim).not.toHaveProperty("topic");
    expect(slim).not.toHaveProperty("purpose");
    expect(slim).not.toHaveProperty("is_member");
    expect(slim).not.toHaveProperty("num_members");
  });
});

describe("mapChannel — IM (direct message)", () => {
  const raw = {
    id: "D001",
    name: "",
    is_private: true,
    is_im: true,
    is_mpim: false,
    is_archived: false,
    user: "U999",
    topic: { value: "", creator: "", last_set: 0 },
    purpose: { value: "", creator: "", last_set: 0 },
  };

  it("returns name=null when name is empty string", () => {
    const slim = mapChannel(raw);
    expect(slim.name).toBeNull();
  });

  it("sets is_im=true", () => {
    const slim = mapChannel(raw);
    expect(slim.is_im).toBe(true);
  });

  it("includes user (DM partner id)", () => {
    const slim = mapChannel(raw);
    expect(slim.user).toBe("U999");
  });

  it("omits topic and purpose when value is empty string", () => {
    const slim = mapChannel(raw);
    expect(slim).not.toHaveProperty("topic");
    expect(slim).not.toHaveProperty("purpose");
  });
});

describe("mapChannel — missing / null fields", () => {
  it("falls back to empty string id and false booleans when all fields absent", () => {
    const slim = mapChannel({});
    expect(slim.id).toBe("");
    expect(slim.name).toBeNull();
    expect(slim.is_private).toBe(false);
    expect(slim.is_im).toBe(false);
    expect(slim.is_mpim).toBe(false);
    expect(slim.is_archived).toBe(false);
  });

  it("does not throw when topic/purpose are not objects", () => {
    const slim = mapChannel({ id: "C003", topic: "bad", purpose: 99 });
    expect(slim).not.toHaveProperty("topic");
    expect(slim).not.toHaveProperty("purpose");
  });
});

// ---------------------------------------------------------------------------
// mapMessage
// ---------------------------------------------------------------------------

describe("mapMessage — plain message", () => {
  const raw = {
    ts: "1234567890.000001",
    type: "message",
    text: "Hello world",
    user: "U001",
    extra_upstream: "drop_me",
  };

  it("maps required fields", () => {
    const slim = mapMessage(raw);
    expect(slim.ts).toBe("1234567890.000001");
    expect(slim.text).toBe("Hello world");
    expect(slim.user).toBe("U001");
  });

  it("includes type when present", () => {
    const slim = mapMessage(raw);
    expect(slim.type).toBe("message");
  });

  it("does not include thread_ts, reply_count, bot_id, subtype when absent", () => {
    const slim = mapMessage(raw);
    expect(slim).not.toHaveProperty("thread_ts");
    expect(slim).not.toHaveProperty("reply_count");
    expect(slim).not.toHaveProperty("bot_id");
    expect(slim).not.toHaveProperty("subtype");
  });

  it("strips upstream extras", () => {
    const slim = mapMessage(raw) as Record<string, unknown>;
    expect(slim).not.toHaveProperty("extra_upstream");
  });
});

describe("mapMessage — threaded reply", () => {
  const raw = {
    ts: "1234567890.000002",
    type: "message",
    text: "Reply here",
    user: "U002",
    thread_ts: "1234567890.000001",
    reply_count: 3,
  };

  it("includes thread_ts and reply_count", () => {
    const slim = mapMessage(raw);
    expect(slim.thread_ts).toBe("1234567890.000001");
    expect(slim.reply_count).toBe(3);
  });
});

describe("mapMessage — bot message", () => {
  it("includes bot_id when present", () => {
    const slim = mapMessage({
      ts: "1234567890.000003",
      text: "Bot says hi",
      user: null,
      bot_id: "B001",
      subtype: "bot_message",
    });
    expect(slim.user).toBeNull();
    expect(slim.bot_id).toBe("B001");
    expect(slim.subtype).toBe("bot_message");
  });
});

describe("mapMessage — missing fields", () => {
  it("returns ts='', text='', user=null when all absent", () => {
    const slim = mapMessage({});
    expect(slim.ts).toBe("");
    expect(slim.text).toBe("");
    expect(slim.user).toBeNull();
  });

  it("does not throw on non-object input", () => {
    expect(() => mapMessage(null)).not.toThrow();
    expect(() => mapMessage("bad")).not.toThrow();
    expect(() => mapMessage(42)).not.toThrow();
  });
});
