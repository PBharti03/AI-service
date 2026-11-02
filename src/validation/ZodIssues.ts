import { z, type ZodError } from "zod";
import type { ErrorDetails } from "../errors/AiServiceError";

const MAX_REPORTED_ISSUES = 5;

/** Placeholder for a path segment that is not a property name declared by the schema. */
export const REDACTED_SEGMENT = "*";

const declaredKeysCache = new WeakMap<z.ZodType, ReadonlySet<string>>();

/**
 * Reduces a ZodError to issue counts, codes and paths that are safe to log.
 *
 * Received values are never included. Path segments are kept only when they
 * are array indices or property names declared by the schema; any other key
 * (for example a key of a z.record, which comes from the data) is replaced
 * with "*".
 */
export function summarizeZodError(error: ZodError, schema: z.ZodType): ErrorDetails {
  const declared = declaredKeys(schema);
  const paths = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) =>
    issue.path.length === 0
      ? "(root)"
      : issue.path
          .map((segment) =>
            typeof segment === "number" || (typeof segment === "string" && declared.has(segment))
              ? String(segment)
              : REDACTED_SEGMENT,
          )
          .join("."),
  );
  const codes = [...new Set(error.issues.map((issue) => issue.code))];
  return {
    issueCount: error.issues.length,
    paths: paths.join(",").slice(0, 300),
    codes: codes.join(",").slice(0, 200),
  };
}

function declaredKeys(schema: z.ZodType): ReadonlySet<string> {
  const cached = declaredKeysCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const keys = new Set<string>();
  try {
    collectPropertyNames(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), keys);
  } catch {
    // A schema that cannot be described yields no declared keys, so every
    // named path segment is redacted: the safe outcome.
    keys.clear();
  }
  declaredKeysCache.set(schema, keys);
  return keys;
}

function collectPropertyNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyNames(item, into);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const entries: [string, unknown][] = Object.entries(node);
  for (const [keyword, value] of entries) {
    if (keyword === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        into.add(name);
      }
    }
    collectPropertyNames(value, into);
  }
}
