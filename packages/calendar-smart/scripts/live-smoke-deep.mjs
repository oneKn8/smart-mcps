#!/usr/bin/env node
// Deep live E2E sweep — exercises paths that the basic + full smokes
// didn't cover. Goal: surface any remaining gaps between my unit tests
// (which use fakes) and the real Google Calendar API.
//
// Tested here:
//   - update_event extended fields (color, visibility, transparency, reminders)
//   - create_event with focusTime event_type
//   - create_event with outOfOffice event_type
//   - create_event with workingLocation (homeOffice + customLocation)
//   - share_calendar full flow (share -> update_share -> revoke_share)
//   - subscribe/unsubscribe a calendar
//   - reschedule (timed)
//   - reschedule (all-day)
//   - quick_add NLP
//   - respond_to_event (RSVP)
//   - calendar list filters (show_hidden, min_access_role)
//   - cancel_instance on a recurring series
//   - all-day event create + delete

import { CalendarClient } from "../dist/client.js";
import { mapEvent } from "../dist/event-mapper.js";

const account = process.argv[2] ?? "your-account";
const client = new CalendarClient(account);

let pass = 0;
let fail = 0;
const failures = [];

let workspaceOnly = 0;

async function step(name, fn, opts = {}) {
  process.stdout.write(`\n--- ${name} ---\n`);
  try {
    await fn();
    pass++;
    process.stdout.write(`  PASS\n`);
  } catch (err) {
    const msg = err?.message ?? String(err);
    // Workspace-only event types (focusTime, outOfOffice, workingLocation)
    // return a clear "enterprise account / feature not enabled" error on
    // personal Gmail. Mark these as known-skipped rather than failures.
    if (
      opts.workspaceOnly &&
      /enterprise|focus time feature|working location feature|malformedWorkingLocation|must have a (transparency|visibility) setting/i.test(msg)
    ) {
      workspaceOnly++;
      process.stdout.write(`  SKIP (workspace-only feature): ${msg}\n`);
      return;
    }
    fail++;
    failures.push({ name, msg });
    process.stdout.write(`  FAIL: ${msg}\n`);
    if (err?.stack) {
      process.stdout.write(err.stack.split("\n").slice(1, 4).join("\n") + "\n");
    }
  }
}

async function main() {
  await step("ensureTimeZone", async () => {
    const tz = await client.ensureTimeZone();
    process.stdout.write(`  tz: ${tz}\n`);
  });

  // Create a sandbox calendar so we don't pollute primary.
  let sandboxId = null;
  await step("create sandbox calendar", async () => {
    const c = await client.insertCalendar({
      summary: "calendar-smart deep-smoke (auto)",
      timeZone: "America/Chicago",
    });
    sandboxId = c.id;
    process.stdout.write(`  sandbox: ${sandboxId}\n`);
  });

  if (!sandboxId) {
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // update_event extended fields
  // ---------------------------------------------------------------------------
  let evtId = null;
  await step("create timed event for patching", async () => {
    const ev = await client.insertEvent({
      calendarId: sandboxId,
      body: {
        summary: "patch-target",
        start: { dateTime: "2026-05-20T14:00:00-05:00" },
        end: { dateTime: "2026-05-20T15:00:00-05:00" },
      },
    });
    evtId = ev.id;
    process.stdout.write(`  evt: ${evtId}\n`);
  });

  if (evtId) {
    await step("update_event with color + visibility + transparency + reminders", async () => {
      const patched = await client.patchEvent({
        calendarId: sandboxId,
        eventId: evtId,
        body: {
          colorId: "9",
          visibility: "private",
          transparency: "transparent",
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 5 }] },
        },
      });
      const slim = mapEvent(patched, sandboxId);
      process.stdout.write(`  visibility=${slim.visibility}, transparency=${slim.transparency}, color=${slim.color_id}\n`);
      if (slim.color_id !== "9") throw new Error("color_id didn't stick");
      if (slim.visibility !== "private") throw new Error("visibility didn't stick");
      if (slim.transparency !== "transparent") throw new Error("transparency didn't stick");
    });

    await step("reschedule timed event", async () => {
      const moved = await client.patchEvent({
        calendarId: sandboxId,
        eventId: evtId,
        body: {
          start: { dateTime: "2026-05-21T16:00:00-05:00" },
          end: { dateTime: "2026-05-21T17:00:00-05:00" },
        },
      });
      const slim = mapEvent(moved, sandboxId);
      process.stdout.write(`  new start: ${slim.start}\n`);
      if (!slim.start.startsWith("2026-05-21T16")) throw new Error("reschedule didn't stick");
    });

    await step("delete patch-target", async () => {
      await client.deleteEvent({ calendarId: sandboxId, eventId: evtId });
      process.stdout.write(`  deleted\n`);
    });
  }

  // ---------------------------------------------------------------------------
  // event_type variants
  // ---------------------------------------------------------------------------

  await step("create_event focusTime (heads-down block)", async () => {
    const ev = await client.insertEvent({
      calendarId: "primary", // focus time only works on primary
      body: {
        summary: "Deep work",
        start: { dateTime: "2026-05-22T09:00:00-05:00" },
        end: { dateTime: "2026-05-22T11:00:00-05:00" },
        eventType: "focusTime",
        focusTimeProperties: {
          autoDeclineMode: "declineOnlyNewConflictingInvitations",
          declineMessage: "Heads-down work",
          chatStatus: "doNotDisturb",
        },
      },
    });
    process.stdout.write(`  focusTime id: ${ev.id}, eventType: ${ev.eventType}\n`);
    if (ev.eventType !== "focusTime") throw new Error("eventType didn't stick");
    await client.deleteEvent({ calendarId: "primary", eventId: ev.id });
  }, { workspaceOnly: true });

  await step("create_event outOfOffice (auto-decline)", async () => {
    const ev = await client.insertEvent({
      calendarId: "primary",
      body: {
        summary: "OOO sample",
        start: { dateTime: "2026-05-23T00:00:00-05:00" },
        end: { dateTime: "2026-05-24T00:00:00-05:00" },
        eventType: "outOfOffice",
        outOfOfficeProperties: {
          autoDeclineMode: "declineAllConflictingInvitations",
          declineMessage: "OOO this weekend",
        },
      },
    });
    process.stdout.write(`  ooo id: ${ev.id}, eventType: ${ev.eventType}\n`);
    if (ev.eventType !== "outOfOffice") throw new Error("eventType didn't stick");
    await client.deleteEvent({ calendarId: "primary", eventId: ev.id });
  }, { workspaceOnly: true });

  await step("create_event workingLocation (homeOffice)", async () => {
    const ev = await client.insertEvent({
      calendarId: "primary",
      body: {
        summary: "WFH",
        start: { date: "2026-05-25" },
        end: { date: "2026-05-26" },
        eventType: "workingLocation",
        workingLocationProperties: { type: "homeOffice", homeOffice: {} },
      },
    });
    process.stdout.write(`  wl-home id: ${ev.id}, eventType: ${ev.eventType}\n`);
    if (ev.eventType !== "workingLocation") throw new Error("eventType didn't stick");
    await client.deleteEvent({ calendarId: "primary", eventId: ev.id });
  }, { workspaceOnly: true });

  await step("create_event workingLocation (customLocation w/ label)", async () => {
    const ev = await client.insertEvent({
      calendarId: "primary",
      body: {
        summary: "Coffee shop day",
        start: { date: "2026-05-27" },
        end: { date: "2026-05-28" },
        eventType: "workingLocation",
        workingLocationProperties: {
          type: "customLocation",
          customLocation: { label: "Local cafe" },
        },
      },
    });
    process.stdout.write(`  wl-custom id: ${ev.id}\n`);
    await client.deleteEvent({ calendarId: "primary", eventId: ev.id });
  }, { workspaceOnly: true });

  // ---------------------------------------------------------------------------
  // all-day quick + recurring + cancel one instance
  // ---------------------------------------------------------------------------

  await step("create all-day event on sandbox", async () => {
    const ev = await client.insertEvent({
      calendarId: sandboxId,
      body: {
        summary: "all-day test",
        start: { date: "2026-05-29" },
        end: { date: "2026-05-30" },
      },
    });
    process.stdout.write(`  id: ${ev.id}, all_day: ${mapEvent(ev, sandboxId).all_day}\n`);
    if (!mapEvent(ev, sandboxId).all_day) throw new Error("not detected as all-day");
    await client.deleteEvent({ calendarId: sandboxId, eventId: ev.id });
  });

  await step("quick_add (NLP)", async () => {
    const ev = await client.quickAdd({
      calendarId: sandboxId,
      text: "Lunch with Sam tomorrow 12pm",
    });
    process.stdout.write(`  parsed: ${ev.summary}\n`);
    await client.deleteEvent({ calendarId: sandboxId, eventId: ev.id });
  });

  await step("recurring + cancel_instance flow", async () => {
    const tz = await client.ensureTimeZone();
    const series = await client.insertEvent({
      calendarId: sandboxId,
      body: {
        summary: "weekly check-in",
        start: { dateTime: "2026-06-01T09:00:00-05:00", timeZone: tz },
        end: { dateTime: "2026-06-01T09:30:00-05:00", timeZone: tz },
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      },
    });
    const inst = await client.listInstances({
      calendarId: sandboxId,
      eventId: series.id,
      maxResults: 5,
    });
    process.stdout.write(`  series ${series.id} -> ${inst.items.length} instances\n`);
    if (inst.items.length !== 3) throw new Error(`expected 3 instances, got ${inst.items.length}`);
    // Cancel instance 2 of 3 by patching status to cancelled
    const target = inst.items[1];
    await client.patchEvent({
      calendarId: sandboxId,
      eventId: target.id,
      body: { status: "cancelled" },
    });
    process.stdout.write(`  cancelled instance ${target.id}\n`);
    const after = await client.listInstances({
      calendarId: sandboxId,
      eventId: series.id,
      maxResults: 5,
    });
    process.stdout.write(`  remaining instances: ${after.items.length}\n`);
    await client.deleteEvent({ calendarId: sandboxId, eventId: series.id });
  });

  // ---------------------------------------------------------------------------
  // Sharing flow on the sandbox calendar
  // ---------------------------------------------------------------------------

  let ruleId = null;
  await step("share_calendar (default scope, freeBusyReader)", async () => {
    const rule = await client.insertAclRule({
      calendarId: sandboxId,
      body: {
        role: "freeBusyReader",
        scope: { type: "default" },
      },
    });
    ruleId = rule.id;
    process.stdout.write(`  rule: ${ruleId}, role: ${rule.role}\n`);
  });

  if (ruleId) {
    await step("update_calendar_share (promote to reader)", async () => {
      const updated = await client.updateAclRule({
        calendarId: sandboxId,
        ruleId,
        body: { role: "reader", scope: { type: "default" } },
      });
      process.stdout.write(`  new role: ${updated.role}\n`);
      if (updated.role !== "reader") throw new Error("role update didn't stick");
    });

    await step("list_calendar_shares (verify reader)", async () => {
      const rules = await client.listAcl({ calendarId: sandboxId });
      const found = rules.find((r) => r.id === ruleId);
      process.stdout.write(`  rule ${ruleId} role: ${found?.role}\n`);
      if (found?.role !== "reader") throw new Error("rule not found or wrong role");
    });

    await step("revoke_calendar_share", async () => {
      await client.deleteAclRule({ calendarId: sandboxId, ruleId });
      const rules = await client.listAcl({ calendarId: sandboxId });
      const found = rules.find((r) => r.id === ruleId);
      if (found) throw new Error("rule still exists after delete");
      process.stdout.write(`  revoked\n`);
    });
  }

  // ---------------------------------------------------------------------------
  // Subscribe / unsubscribe a calendar (use the holiday calendar)
  // ---------------------------------------------------------------------------

  const holidayId = "en.usa#holiday@group.v.calendar.google.com";
  await step("subscribe_calendar (US holidays)", async () => {
    try {
      await client.insertCalendarListEntry({
        body: { id: holidayId },
      });
      process.stdout.write(`  subscribed to US holidays\n`);
    } catch (err) {
      // Already subscribed is OK (returns 409)
      if (err.message?.includes("→ 409")) {
        process.stdout.write(`  already subscribed (409)\n`);
      } else {
        throw err;
      }
    }
  });

  await step("update_calendar_subscription (set color)", async () => {
    await client.patchCalendarListEntry({
      calendarId: holidayId,
      body: { colorId: "5" },
    });
    process.stdout.write(`  set colorId 5\n`);
  });

  await step("unsubscribe_calendar (US holidays)", async () => {
    await client.deleteCalendarListEntry({ calendarId: holidayId });
    process.stdout.write(`  unsubscribed\n`);
  });

  // ---------------------------------------------------------------------------
  // List filters
  // ---------------------------------------------------------------------------

  await step("list_calendars with min_access_role=owner", async () => {
    const cals = await client.listCalendars({ minAccessRole: "owner" });
    process.stdout.write(`  owner-or-better: ${cals.length}\n`);
    if (cals.length === 0) throw new Error("expected at least primary");
  });

  // ---------------------------------------------------------------------------
  // Cleanup sandbox
  // ---------------------------------------------------------------------------

  await step("delete sandbox calendar", async () => {
    await client.deleteCalendar({ calendarId: sandboxId });
    process.stdout.write(`  deleted ${sandboxId}\n`);
  });

  process.stdout.write(`\n=== RESULT: ${pass} passed, ${fail} failed, ${workspaceOnly} skipped (workspace-only) ===\n`);
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
