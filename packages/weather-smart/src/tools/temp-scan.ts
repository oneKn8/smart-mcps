import type { HourlyEntry } from "../client.js";

// Groups hourly forecast entries by their local calendar date (YYYY-MM-DD).
// Open-Meteo returns ISO-local strings without a Z suffix when called with
// `timezone=auto`, so the date prefix before the `T` is the local date and
// stable across timezones — never reparse via Date+toISOString (that would
// re-anchor to UTC). Used by frost_alert and heat_advisory to identify the
// extreme-temperature hour per local day.
export function groupByDate(
  entries: HourlyEntry[],
): Map<string, HourlyEntry[]> {
  const groups = new Map<string, HourlyEntry[]>();
  for (const entry of entries) {
    const date = entry.time.split("T")[0] ?? entry.time;
    const bucket = groups.get(date);
    if (bucket) bucket.push(entry);
    else groups.set(date, [entry]);
  }
  return groups;
}
