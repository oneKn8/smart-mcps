#!/usr/bin/env node
// Live E2E smoke against the real Google Calendar API. Requires the calendar
// token at ~/.santo-agent/oauth/<account>.calendar.json (mint via
// `node packages/calendar-smart/dist/bin/calendar-smart-auth.js <account>`).
//
// Usage:
//   node packages/calendar-smart/scripts/live-smoke.mjs [account]
// Account comes from argv[2] or CALENDAR_DEFAULT_IDENTITY.

import { CalendarClient } from "../dist/client.js";
import { mapEvent } from "../dist/event-mapper.js";
import { mapCalendar } from "../dist/calendar-mapper.js";
import {
  startOfDay,
  endOfDay,
  formatIso,
  todayInTz,
} from "../dist/time-zone.js";

const account = process.argv[2] ?? process.env.CALENDAR_DEFAULT_IDENTITY;
if (!account) {
  console.error("usage: node " + process.argv[1] + " <account>");
  process.exit(1);
}
const client = new CalendarClient(account);

function divider(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

async function main() {
  divider("ensureTimeZone");
  const tz = await client.ensureTimeZone();
  process.stdout.write(`primary tz: ${tz}\n`);

  divider("listCalendars");
  const calsRaw = await client.listCalendars();
  const cals = calsRaw.map(mapCalendar);
  process.stdout.write(`calendars: ${cals.length}\n`);
  for (const c of cals.slice(0, 10)) {
    process.stdout.write(
      `  ${c.primary ? "*" : " "} ${c.id.slice(0, 60).padEnd(60)} | ${c.access_role.padEnd(15)} | ${c.summary}\n`,
    );
  }

  divider("daily_agenda (today)");
  const today = todayInTz(tz);
  const dayStart = startOfDay(today, tz);
  const dayEnd = endOfDay(today, tz);
  const result = await client.listEvents({
    calendarId: "primary",
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 25,
  });
  const events = result.items.map((e) => mapEvent(e, "primary"));
  process.stdout.write(
    `today (${today}, ${formatIso(dayStart, tz)} -> ${formatIso(dayEnd, tz)}): ${events.length} events\n`,
  );
  for (const e of events.slice(0, 10)) {
    const time = e.all_day ? "[all day]" : `${e.start} -> ${e.end}`;
    process.stdout.write(
      `  ${time}  ${e.summary}${e.location ? `  @ ${e.location}` : ""}\n`,
    );
  }

  divider("listEvents (next 7 days)");
  const weekEnd = new Date(dayStart.getTime() + 7 * 24 * 3600 * 1000);
  const weekResult = await client.listEvents({
    calendarId: "primary",
    timeMin: dayStart.toISOString(),
    timeMax: weekEnd.toISOString(),
    maxResults: 50,
  });
  process.stdout.write(`next 7 days: ${weekResult.items.length} events\n`);

  divider("freeBusy (next 7 days, primary)");
  const fb = await client.freeBusy({
    timeMin: dayStart.toISOString(),
    timeMax: weekEnd.toISOString(),
    calendarIds: ["primary"],
  });
  const busyCount = fb.calendars.primary?.busy?.length ?? 0;
  process.stdout.write(`busy windows on primary in next 7d: ${busyCount}\n`);

  divider("RESULT");
  process.stdout.write("OK: live smoke passed against real Google Calendar API.\n");
}

main().catch((err) => {
  process.stderr.write(`\nFAIL: ${err?.message ?? err}\n`);
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
