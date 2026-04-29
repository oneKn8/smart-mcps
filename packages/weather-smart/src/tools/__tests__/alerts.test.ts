import { describe, it, expect, vi } from "vitest";
import { getAlerts } from "../alerts.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  NwsAlert,
  GeocodeMatch,
} from "../../client.js";

function alert(overrides: Partial<NwsAlert> = {}): NwsAlert {
  return {
    id: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc",
    event: "Tornado Warning",
    severity: "Extreme",
    urgency: "Immediate",
    certainty: "Observed",
    headline: "Tornado Warning issued April 29 at 2:00PM CDT",
    expires: "2026-04-29T14:30:00-05:00",
    areas: "Dallas, TX; Tarrant, TX",
    ...overrides,
  };
}

function makeCtx(opts: {
  alerts?: NwsAlert[];
  matches?: GeocodeMatch[];
  defaultLocation?: string | undefined;
}): {
  ctx: WeatherContext;
  getNwsAlerts: ReturnType<typeof vi.fn>;
  geocode: ReturnType<typeof vi.fn>;
} {
  const getNwsAlertsStub = vi
    .fn()
    .mockResolvedValue({ alerts: opts.alerts ?? [] });
  const geocode = vi.fn().mockResolvedValue({ matches: opts.matches ?? [] });
  const ctx: WeatherContext = {
    client: {
      geocode,
      getNwsAlerts: getNwsAlertsStub,
    } as unknown as WeatherClient,
    defaults: {
      units: "imperial",
      location: opts.defaultLocation,
    },
  };
  return { ctx, getNwsAlerts: getNwsAlertsStub, geocode };
}

describe("get_alerts — metadata", () => {
  it("has correct name and description", () => {
    expect(getAlerts.name).toBe("get_alerts");
    expect(getAlerts.description).toBe(
      "Active weather alerts (US lower-48 only).",
    );
  });
});

describe("get_alerts — US coordinates", () => {
  it("calls client.getNwsAlerts and returns mapped alerts (no note)", async () => {
    const a = alert();
    const { ctx, getNwsAlerts } = makeCtx({ alerts: [a] });
    const result = await getAlerts.handler(
      { lat: 32.7767, lng: -96.797 },
      ctx,
    );
    expect(getNwsAlerts).toHaveBeenCalledTimes(1);
    expect(getNwsAlerts).toHaveBeenCalledWith(32.7767, -96.797);
    expect(result.alerts).toEqual([a]);
    expect(result.note).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["alerts", "location"]);
  });

  it("US empty alerts list returns { alerts: [] } with NO note (different from non-US)", async () => {
    const { ctx, getNwsAlerts } = makeCtx({ alerts: [] });
    const result = await getAlerts.handler(
      { lat: 32.7767, lng: -96.797 },
      ctx,
    );
    expect(getNwsAlerts).toHaveBeenCalledTimes(1);
    expect(result.alerts).toEqual([]);
    expect(result.note).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["alerts", "location"]);
  });

  it("includes resolved location in output", async () => {
    const { ctx } = makeCtx({ alerts: [] });
    const result = await getAlerts.handler(
      { lat: 32.7767, lng: -96.797 },
      ctx,
    );
    expect(result.location).toEqual({
      name: "32.7767,-96.7970",
      lat: 32.7767,
      lng: -96.797,
      timezone: "auto",
    });
  });
});

describe("get_alerts — non-US short-circuit", () => {
  it("London short-circuits, returns empty + note, never calls NWS", async () => {
    const { ctx, getNwsAlerts } = makeCtx({});
    const result = await getAlerts.handler(
      { lat: 51.5074, lng: -0.1278 },
      ctx,
    );
    expect(getNwsAlerts).toHaveBeenCalledTimes(0);
    expect(result.alerts).toEqual([]);
    expect(result.note).toBe("alerts only available for US locations");
    expect(Object.keys(result).sort()).toEqual(["alerts", "location", "note"]);
  });

  it("Sydney short-circuits, returns empty + note, never calls NWS", async () => {
    const { ctx, getNwsAlerts } = makeCtx({});
    const result = await getAlerts.handler(
      { lat: -33.8688, lng: 151.2093 },
      ctx,
    );
    expect(getNwsAlerts).toHaveBeenCalledTimes(0);
    expect(result.alerts).toEqual([]);
    expect(result.note).toBe("alerts only available for US locations");
  });
});

describe("get_alerts — bbox boundaries (inclusive)", () => {
  it("lat exactly at southern boundary 24.5 still counts as US (calls NWS)", async () => {
    const { ctx, getNwsAlerts } = makeCtx({ alerts: [] });
    const result = await getAlerts.handler({ lat: 24.5, lng: -80 }, ctx);
    expect(getNwsAlerts).toHaveBeenCalledTimes(1);
    expect(result.note).toBeUndefined();
  });

  it("lng exactly at western boundary -125 still counts as US (calls NWS)", async () => {
    const { ctx, getNwsAlerts } = makeCtx({ alerts: [] });
    const result = await getAlerts.handler({ lat: 40, lng: -125 }, ctx);
    expect(getNwsAlerts).toHaveBeenCalledTimes(1);
    expect(result.note).toBeUndefined();
  });
});

describe("get_alerts — location resolution", () => {
  it("calls geocode when input has location string", async () => {
    const { ctx, geocode, getNwsAlerts } = makeCtx({
      matches: [
        {
          name: "Dallas",
          lat: 32.7767,
          lng: -96.797,
          timezone: "America/Chicago",
          country: "United States",
          admin1: "Texas",
        },
      ],
    });
    const result = await getAlerts.handler({ location: "Dallas" }, ctx);
    expect(geocode).toHaveBeenCalledWith("Dallas");
    expect(getNwsAlerts).toHaveBeenCalledTimes(1);
    expect(result.location.name).toBe("Dallas, Texas, United States");
  });
});
