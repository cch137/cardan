import { CardanError } from "./errors.js";

/** A plain JSON Schema object. Not validated by cardan. */
export type JsonSchema = Record<string, unknown>;

/**
 * Minimal structural view of a zod 4 schema. Detection is duck-typed so zod
 * stays an optional peer dependency. The `parse` return type carries the
 * inferred output, letting {@link Infer} recover it without importing zod.
 */
export interface ZodLikeSchema<T = unknown> {
  _zod: unknown;
  parse(data: unknown): T;
}

export type SchemaInput = JsonSchema | ZodLikeSchema;

/**
 * The value type a schema validates to: a zod schema resolves to its parsed
 * output type; a plain JSON Schema (which carries no static type) resolves to
 * `unknown`.
 */
export type Infer<S> = S extends ZodLikeSchema<infer T> ? T : unknown;

export function isZodSchema(input: SchemaInput): input is ZodLikeSchema {
  return (
    typeof input === "object" &&
    input !== null &&
    "_zod" in input &&
    typeof (input as { parse?: unknown }).parse === "function"
  );
}

/**
 * Converts a SchemaInput to a plain JSON Schema. zod schemas are converted
 * via zod 4's native `toJSONSchema` (dynamically imported, so the dependency
 * is only loaded when a zod schema is actually passed).
 */
export async function toJsonSchema(input: SchemaInput): Promise<JsonSchema> {
  if (!isZodSchema(input)) return input;
  let mod: Record<string, unknown>;
  try {
    mod = (await import("zod")) as Record<string, unknown>;
  } catch (cause) {
    throw new CardanError(
      "invalid_request",
      "a zod schema was provided but the optional peer dependency `zod` is not installed",
      { cause },
    );
  }
  const z = mod.z as Record<string, unknown> | undefined;
  const toJSONSchema = (mod.toJSONSchema ?? z?.toJSONSchema) as
    | ((schema: unknown, options?: unknown) => JsonSchema)
    | undefined;
  if (typeof toJSONSchema !== "function") {
    throw new CardanError(
      "invalid_request",
      "installed `zod` version does not export `toJSONSchema`; zod >= 4 is required",
    );
  }
  return toJSONSchema(input);
}

/**
 * Validates a structured-output value against the caller's schema. zod
 * schemas validate via `.parse()` (throws on mismatch); plain JSON Schemas
 * are passed through unvalidated.
 */
export function validateOutput(schema: SchemaInput, value: unknown): unknown {
  if (isZodSchema(schema)) return schema.parse(value);
  return value;
}
