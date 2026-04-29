import { z } from "zod";

// Shared base schema for any tool that accepts a location either as explicit
// coordinates or a free-text place name. Every weather tool extends this with
// its own per-tool fields (units, days, hours, etc.). Kept as a plain object
// schema (not `.optional()` or wrapped in `.default(...)`) so consumers can
// `.extend(...)` cleanly.
export const locationInput = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  location: z.string().min(1).optional(),
});

export type LocationInputShape = z.infer<typeof locationInput>;
