import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

describe("slack-smart tool wiring", () => {
  it("exports the expected number of tools", () => {
    expect(tools).toHaveLength(40);
  });

  it("tool names include whoami", () => {
    expect(tools.map((t) => t.name)).toContain("whoami");
  });

  it("tool names include all 6 conversations tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_channels");
    expect(names).toContain("channel_history");
    expect(names).toContain("thread_replies");
    expect(names).toContain("channel_info");
    expect(names).toContain("channel_members");
    expect(names).toContain("open_dm");
  });

  it("tool names include all 5 message write tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("post_message");
    expect(names).toContain("reply_in_thread");
    expect(names).toContain("update_message");
    expect(names).toContain("delete_message");
    expect(names).toContain("schedule_message");
  });

  it("tool names include all 2 search tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_messages");
    expect(names).toContain("search_files");
  });

  it("tool names include all 3 reaction tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("add_reaction");
    expect(names).toContain("remove_reaction");
    expect(names).toContain("get_reactions");
  });

  it("tool names include all 6 user tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_users");
    expect(names).toContain("user_info");
    expect(names).toContain("user_profile");
    expect(names).toContain("lookup_by_email");
    expect(names).toContain("user_presence");
    expect(names).toContain("resolve_user");
  });

  it("all names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("tool names include all 3 file tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_files");
    expect(names).toContain("file_info");
    expect(names).toContain("upload_file");
  });

  it("tool names include all 3 pins tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_pins");
    expect(names).toContain("pin_message");
    expect(names).toContain("unpin_message");
  });

  it("tool names include all 3 dnd tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("dnd_status");
    expect(names).toContain("set_snooze");
    expect(names).toContain("end_snooze");
  });

  it("tool names include all 3 misc tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_usergroups");
    expect(names).toContain("team_info");
    expect(names).toContain("list_emoji");
  });

  it("tool names include all 5 smart composite tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("catch_me_up");
    expect(names).toContain("mentions");
    expect(names).toContain("unread_digest");
    expect(names).toContain("thread_catchup");
    expect(names).toContain("smart_send");
  });

  it("all names are snake_case", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("all descriptions are non-empty and <= 120 chars", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(120);
    }
  });

  it("all descriptions are unique", () => {
    const descs = tools.map((t) => t.description);
    expect(new Set(descs).size).toBe(descs.length);
  });
});
