import { describe, it, expect } from "vitest";
import { fuzzyRank, resolveOne, type FuzzyMatch } from "../fuzzy.js";
import { AmbiguousMatchError, NotFoundError } from "../errors.js";

const items = [
  { id: "1", name: "alpha-site" },
  { id: "2", name: "alpha-marketing" },
  { id: "3", name: "alpha-staging" },
  { id: "4", name: "another-project" },
];

describe("fuzzyRank", () => {
  it("returns sorted matches by score desc", () => {
    const matches = fuzzyRank("alpha-s", items, i => i.name);
    expect(matches[0]?.item.name).toBe("alpha-site");
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("scores exact match at 1.0", () => {
    const matches = fuzzyRank("alpha-site", items, i => i.name);
    expect(matches[0]?.score).toBe(1);
  });

  it("scores totally unrelated below 0.5", () => {
    const matches = fuzzyRank("xyzzz", items, i => i.name);
    const top = matches[0];
    expect(top?.score).toBeLessThan(0.5);
  });
});

describe("resolveOne", () => {
  it("returns single item when score >= threshold", () => {
    const result = resolveOne("alpha-s", items, i => i.name, { threshold: 0.5 });
    expect(result.id).toBe("1");
  });

  it("throws AmbiguousMatchError when top score below threshold", () => {
    expect(() =>
      resolveOne("alph", items, i => i.name, { threshold: 0.99 }),
    ).toThrowError(AmbiguousMatchError);
  });

  it("throws NotFoundError when no items", () => {
    expect(() =>
      resolveOne("anything", [], (i: { name: string }) => i.name),
    ).toThrowError(NotFoundError);
  });

  it("AmbiguousMatchError carries top 3 candidates", () => {
    try {
      resolveOne("alph", items, i => i.name, { threshold: 0.99 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousMatchError);
      expect((err as AmbiguousMatchError).candidates.length).toBeLessThanOrEqual(3);
      expect((err as AmbiguousMatchError).candidates[0]).toMatchObject({
        label: expect.any(String),
        score: expect.any(Number),
      });
    }
  });
});
