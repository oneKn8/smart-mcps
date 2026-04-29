import { describe, it, expect } from "vitest";
import { weatherCodeLabel } from "../weather-codes.js";

describe("weatherCodeLabel", () => {
  it("returns correct label for known codes", () => {
    expect(weatherCodeLabel(0)).toBe("Clear sky");
    expect(weatherCodeLabel(61)).toBe("Light rain");
    expect(weatherCodeLabel(95)).toBe("Thunderstorm");
  });

  it("returns 'Unknown (<code>)' for unknown positive codes", () => {
    expect(weatherCodeLabel(123)).toBe("Unknown (123)");
  });

  it("returns 'Unknown (<code>)' for negative codes", () => {
    expect(weatherCodeLabel(-1)).toBe("Unknown (-1)");
  });
});
