import { describe, it, expect } from "vitest";
import { buildWatcherScript, clampEveryMinutes } from "../watcher-script.js";

describe("clampEveryMinutes", () => {
  it("snaps to the nearest Apps Script-allowed cadence", () => {
    expect(clampEveryMinutes(15)).toBe(15);
    expect(clampEveryMinutes(7)).toBe(5);
    expect(clampEveryMinutes(12)).toBe(10);
    expect(clampEveryMinutes(60)).toBe(30);
    expect(clampEveryMinutes(2)).toBe(1);
  });
});

describe("buildWatcherScript", () => {
  const files = buildWatcherScript({
    query: "is:unread in:inbox",
    tasklist: "@default",
    pollFunction: "pollInboxToTasks",
    installFunction: "installTrigger",
    everyMinutes: 15,
    maxThreads: 25,
  });

  it("generates a poll function that searches Gmail and inserts Tasks", () => {
    expect(files.code).toContain("function pollInboxToTasks()");
    expect(files.code).toContain("GmailApp.search(WATCHER_QUERY");
    expect(files.code).toContain("Tasks.Tasks.insert(");
    expect(files.code).toContain('"is:unread in:inbox"');
    expect(files.code).toContain('"@default"');
  });

  it("generates a self-installing time trigger (the API cannot create it)", () => {
    expect(files.code).toContain("function installTrigger()");
    expect(files.code).toContain('ScriptApp.newTrigger("pollInboxToTasks")');
    expect(files.code).toContain(".everyMinutes(15)");
  });

  it("emits a manifest enabling the advanced Tasks service + scopes", () => {
    const manifest = JSON.parse(files.manifest);
    expect(manifest.dependencies.enabledAdvancedServices[0].serviceId).toBe(
      "tasks",
    );
    expect(manifest.oauthScopes).toContain(
      "https://www.googleapis.com/auth/script.scriptapp",
    );
    expect(manifest.runtimeVersion).toBe("V8");
  });

  it("clamps the cadence and reports it", () => {
    const f = buildWatcherScript({
      query: "is:unread",
      tasklist: "@default",
      pollFunction: "poll",
      installFunction: "install",
      everyMinutes: 7,
      maxThreads: 10,
    });
    expect(f.everyMinutes).toBe(5);
    expect(f.code).toContain(".everyMinutes(5)");
  });
});
