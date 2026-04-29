// Resolves a user-provided location (either explicit lat/lng, a free-form
// city/place string, or falls back to a configured default) into a canonical
// `ResolvedLocation` carrying coordinates, a display name, and timezone.
//
// Resolution precedence: input.lat/lng → input.location → defaults.location.
// When lat/lng are supplied directly we never hit the geocoder; the timezone
// is left as "auto" so Open-Meteo's forecast endpoints can resolve it from
// the coordinates themselves. When a location string is supplied (or the
// default is used) we call the injected `geocode` function and take the top
// match.

export type ResolvedLocation = {
  lat: number;
  lng: number;
  name: string;
  timezone: string;
};

export type LocationInput = {
  lat?: number;
  lng?: number;
  location?: string;
};

export type Defaults = {
  units: "metric" | "imperial";
  location?: string;
};

export type GeocodeFn = (query: string) => Promise<{
  matches: Array<{
    name: string;
    lat: number;
    lng: number;
    timezone: string;
    admin1?: string;
    country?: string;
  }>;
}>;

export async function resolveLocation(
  input: LocationInput,
  defaults: Defaults,
  geocode: GeocodeFn,
): Promise<ResolvedLocation> {
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    return {
      lat: input.lat,
      lng: input.lng,
      name: `${input.lat.toFixed(4)},${input.lng.toFixed(4)}`,
      timezone: "auto", // Open-Meteo will resolve from coordinates
    };
  }

  const query = input.location ?? defaults.location;
  if (!query) {
    throw new Error(
      "location required: pass {lat,lng} or {location} or set WEATHER_DEFAULT_LOCATION",
    );
  }

  const { matches } = await geocode(query);
  const top = matches[0];
  if (!top) throw new Error(`no location match for '${query}'`);

  const display = [top.name, top.admin1, top.country]
    .filter((part): part is string => Boolean(part))
    .join(", ");

  return {
    lat: top.lat,
    lng: top.lng,
    name: display,
    timezone: top.timezone,
  };
}
