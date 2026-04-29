import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../server.js";

describe("zodToJsonSchema", () => {
  it("converts a plain object schema with required + optional fields", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    });
  });

  it("unwraps ZodEffects produced by .refine() and exposes inner shape", () => {
    const schema = z
      .object({
        add_label: z.string().optional(),
        remove_label: z.string().optional(),
      })
      .refine((d) => d.add_label !== undefined || d.remove_label !== undefined, {
        message: "at least one required",
      });

    const result = zodToJsonSchema(schema);

    expect(result).toEqual({
      type: "object",
      properties: {
        add_label: { type: "string" },
        remove_label: { type: "string" },
      },
    });
  });

  it("unwraps ZodEffects produced by .transform()", () => {
    const schema = z.object({ value: z.string() }).transform((d) => d.value);
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });

  it("unwraps nested ZodEffects (refine on a refined schema)", () => {
    const schema = z
      .object({ a: z.string(), b: z.string() })
      .refine(() => true, { message: "outer" })
      .refine(() => true, { message: "inner" });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });
});
