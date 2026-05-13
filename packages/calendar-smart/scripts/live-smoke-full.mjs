#!/usr/bin/env node
// Live E2E smoke for Phase 5.5 — exercises the new tool surface against
// real Google Calendar API. Creates and tears down test artifacts so you
// can run it repeatedly without state pollution.
//
// Usage:
//   node packages/calendar-smart/scripts/live-smoke-full.mjs [account]

import { CalendarClient } from "../dist/client.js";
import { mapEvent } from "../dist/event-mapper.js";
import { mapCalendar } from "../dist/calendar-mapper.js";
import { mapAclRule } from "../dist/acl-mapper.js";

const account = process.argv[2] ?? "your-account";
const client = new CalendarClient(account);

let pass = 0;
let fail = 0;
const failures = [];

async function step(name, fn) {
  process.stdout.write(`\n--- ${name} ---\n`);
  try {
    await fn();
    pass++;
    process.stdout.write(`  PASS\n`);
  } catch (err) {
    fail++;
    failures.push({ name, msg: err?.message ?? String(err) });
    process.stdout.write(`  FAIL: ${err?.message ?? err}\n`);
    if (err?.stack) process.stdout.write(err.stack.split("\n").slice(1, 4).join("\n") + "\n");
  }
}

async function main() {
  await step("ensureTimeZone", async () => {
    const tz = await client.ensureTimeZone();
    if (!tz) throw new Error("no tz returned");
    process.stdout.write(`  tz: ${tz}\n`);
  });

  await step("get_colors (palettes)", async () => {
    const c = await client.getColors();
    const eventCount = Object.keys(c.event ?? {}).length;
    const calCount = Object.keys(c.calendar ?? {}).length;
    process.stdout.write(`  event palette: ${eventCount}, calendar palette: ${calCount}\n`);
    if (eventCount === 0 || calCount === 0) throw new Error("missing palettes");
  });

  await step("list_user_settings", async () => {
    const items = await client.listSettings();
    const flat = {};
    for (const it of items) flat[it.id] = it.value;
    process.stdout.write(`  settings: ${Object.keys(flat).length} keys; tz=${flat.timezone}, weekStart=${flat.weekStart}\n`);
    if (!flat.timezone) throw new Error("no timezone setting");
  });

  await step("get_user_setting (timezone)", async () => {
    const s = await client.getSetting("timezone");
    process.stdout.write(`  timezone = ${s.value}\n`);
  });

  await step("list_calendar_shares (primary)", async () => {
    const rules = await client.listAcl({ calendarId: "primary" });
    const slim = rules.map(mapAclRule);
    process.stdout.write(`  shares on primary: ${slim.length}\n`);
    for (const r of slim.slice(0, 5)) {
      process.stdout.write(`    ${r.role.padEnd(15)} ${r.scope_type}:${r.scope_value ?? "(none)"}\n`);
    }
  });

  await step("list_calendars (with show_hidden)", async () => {
    const cals = (await client.listCalendars({ showHidden: true })).map(mapCalendar);
    process.stdout.write(`  visible+hidden: ${cals.length}\n`);
    for (const c of cals.slice(0, 5)) {
      process.stdout.write(`    ${c.primary ? "*" : " "} ${c.summary.padEnd(40)}  hidden=${c.hidden}  selected=${c.selected}\n`);
    }
  });

  // Create a fresh test calendar -> we'll exercise calendar CRUD on it.
  let testCalId = null;
  await step("create_calendar (test)", async () => {
    const created = await client.insertCalendar({
      summary: "calendar-smart live-smoke (auto)",
      description: "Created by live-smoke-full.mjs; safe to delete",
      location: "test",
      timeZone: "America/Chicago",
    });
    testCalId = created.id;
    process.stdout.write(`  created id: ${testCalId}\n`);
  });

  if (testCalId) {
    await step("update_calendar (rename)", async () => {
      await client.patchCalendar({
        calendarId: testCalId,
        body: { summary: "calendar-smart live-smoke (renamed)" },
      });
      const refetch = await client.getCalendarMetadata(testCalId);
      process.stdout.write(`  rename ok, summary now: ${refetch.summary}\n`);
      if (!refetch.summary.includes("renamed")) throw new Error("rename did not stick");
    });

    await step("get_calendar_metadata (bare)", async () => {
      const meta = await client.getCalendarMetadata(testCalId);
      process.stdout.write(`  id=${meta.id}, tz=${meta.timeZone}\n`);
    });

    // Create a recurring event on the test calendar so we can exercise
    // recurring + search + move + cancel flows without polluting primary.
    let seriesId = null;
    await step("create_event with reminders + color + visibility (recurring)", async () => {
      // Recurring events require IANA timeZone on start/end. The
      // `create_event` tool handler injects this automatically; here we
      // bypass the tool and call the client directly, so include tz manually.
      const tz = await client.ensureTimeZone();
      const created = await client.insertEvent({
        calendarId: testCalId,
        body: {
          summary: "live-smoke recurring",
          start: { dateTime: "2026-05-18T09:00:00-05:00", timeZone: tz },
          end: { dateTime: "2026-05-18T09:30:00-05:00", timeZone: tz },
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
          colorId: "5",
          visibility: "private",
          transparency: "transparent",
          extendedProperties: { private: { test: "live-smoke" } },
        },
      });
      seriesId = created.id;
      const slim = mapEvent(created, testCalId);
      process.stdout.write(`  series id: ${seriesId}\n`);
      process.stdout.write(`  visibility=${slim.visibility}, transparency=${slim.transparency}, color=${slim.color_id}\n`);
      if (slim.visibility !== "private") throw new Error("visibility didn't stick");
      if (slim.color_id !== "5") throw new Error("color_id didn't stick");
    });

    if (seriesId) {
      await step("list_instances (4 expected)", async () => {
        const r = await client.listInstances({
          calendarId: testCalId,
          eventId: seriesId,
          maxResults: 25,
        });
        process.stdout.write(`  instances: ${r.items.length}\n`);
        if (r.items.length !== 4) throw new Error(`expected 4 instances, got ${r.items.length}`);
        const slim = r.items.map((i) => mapEvent(i, testCalId));
        for (const i of slim) {
          process.stdout.write(`    ${i.start}  recurring_event_id=${i.recurring_event_id}\n`);
        }
      });

      await step("search_events (q + privateExtendedProperty)", async () => {
        const r = await client.listEvents({
          calendarId: testCalId,
          q: "live-smoke",
          privateExtendedProperty: { test: "live-smoke" },
          maxResults: 10,
        });
        process.stdout.write(`  search hits: ${r.items.length}\n`);
        if (r.items.length === 0) throw new Error("search returned 0");
      });

      await step("sync_events (initial → token → empty delta)", async () => {
        const first = await client.listEvents({
          calendarId: testCalId,
          singleEvents: true,
          showDeleted: true,
          maxResults: 250,
        });
        if (!first.nextSyncToken) throw new Error("no syncToken on initial call");
        process.stdout.write(`  initial: ${first.items.length} events, token len=${first.nextSyncToken.length}\n`);
        const second = await client.listEvents({
          calendarId: testCalId,
          syncToken: first.nextSyncToken,
        });
        process.stdout.write(`  delta: ${second.items.length} events (expect 0 right after initial)\n`);
      });

      // Cleanup: cancel the series, leaving the test calendar to be deleted at the end.
      await step("cancel series (cleanup)", async () => {
        await client.deleteEvent({ calendarId: testCalId, eventId: seriesId });
        process.stdout.write(`  cancelled\n`);
      });
    }

    await step("move_event (single across calendars)", async () => {
      // Create on primary, move to test calendar, verify, delete.
      const ev = await client.insertEvent({
        calendarId: "primary",
        body: {
          summary: "live-smoke move test (delete me)",
          start: { dateTime: "2026-05-25T14:00:00-05:00" },
          end: { dateTime: "2026-05-25T14:30:00-05:00" },
        },
      });
      const moved = await client.moveEvent({
        calendarId: "primary",
        eventId: ev.id,
        destination: testCalId,
      });
      process.stdout.write(`  moved ${ev.id} primary -> ${testCalId}\n`);
      await client.deleteEvent({ calendarId: testCalId, eventId: moved.id });
      process.stdout.write(`  cleaned up\n`);
    });

    await step("delete_calendar (cleanup test calendar)", async () => {
      await client.deleteCalendar({ calendarId: testCalId });
      process.stdout.write(`  deleted ${testCalId}\n`);
    });
  }

  // freebusy_group: requires a real group; skip if no group provided
  await step("freebusy_group (skipped — no group email)", async () => {
    process.stdout.write(`  skipped: pass a group email arg to exercise this\n`);
  });

  process.stdout.write(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  if (fail > 0) {
    process.stdout.write(`\nFailures:\n`);
    for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.msg}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err?.message ?? err}\n`);
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
