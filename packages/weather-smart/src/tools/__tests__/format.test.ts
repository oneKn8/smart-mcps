import { describe, it, expect } from "vitest";
import {
  formatTemp,
  formatWind,
  formatPercent,
  formatPrecipitation,
  formatPressure,
  formatVisibility,
} from "../format.js";

describe("formatTemp", () => {
  it("rounds and adds F suffix in imperial", () => {
    expect(formatTemp(72.4, "imperial")).toBe("72F");
  });

  it("rounds and adds C suffix in metric", () => {
    expect(formatTemp(22.6, "metric")).toBe("23C");
  });
});

describe("formatWind", () => {
  it("appends compass direction in imperial", () => {
    expect(formatWind(15.2, 180, "imperial")).toBe("15mph S");
  });

  it("omits direction when undefined in metric", () => {
    expect(formatWind(10, undefined, "metric")).toBe("10km/h");
  });
});

describe("formatPercent", () => {
  it("rounds and appends %", () => {
    expect(formatPercent(45.6)).toBe("46%");
  });
});

describe("formatPrecipitation", () => {
  it("uses two decimals + 'in' in imperial", () => {
    expect(formatPrecipitation(0.05, "imperial")).toBe("0.05in");
  });

  it("uses one decimal + 'mm' in metric", () => {
    expect(formatPrecipitation(2.34, "metric")).toBe("2.3mm");
  });
});

describe("formatPressure", () => {
  it("rounds and appends hPa regardless of unit system", () => {
    expect(formatPressure(1013.4)).toBe("1013hPa");
  });
});

describe("formatVisibility", () => {
  it("converts feet to mi in imperial", () => {
    // 10560 ft = 2.0 mi exactly
    expect(formatVisibility(10560, "imperial")).toBe("2.0mi");
  });

  it("converts metres to km in metric", () => {
    expect(formatVisibility(8000, "metric")).toBe("8.0km");
  });
});
