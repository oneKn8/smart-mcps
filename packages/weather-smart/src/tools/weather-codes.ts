// Maps WMO weather interpretation codes (as returned by Open-Meteo's
// weather_code variable) to human-readable labels. Reference:
// https://open-meteo.com/en/docs#weathervariables — the WMO 4677 lookup table.
// Codes outside the table fall back to "Unknown (<code>)" so callers always
// get a non-empty string and unrecognised codes are debuggable from the label.
export function weatherCodeLabel(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Light rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Light snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Severe thunderstorm with hail",
  };
  return map[code] ?? `Unknown (${code})`;
}
