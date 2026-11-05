import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";

/**
 * The application's description of its analytics, used to guide planning and to label results. It
 * carries no access rights: which tables, columns and values may be queried is decided by the SQL policy
 * behind the application's validator (defineSqlPolicy), and nothing here can widen it.
 *
 *   metrics        named measures with a short description (for example "orders: count(*) FROM orders")
 *   dimensions     named breakdowns (for example "channel", "month")
 *   limitations    what the data cannot answer; the planner reports such parts as unanswered
 *   labels         display names for result columns (alias -> label)
 *   valueLabels    display names for category values (value -> label)
 *   locale         number formatting, for example "en-US"
 *   smallSampleBelow  totals below this get a small-numbers caution
 */

const vocabularySchema = z
  .array(z.strictObject({ name: z.string().trim().min(1).max(60), description: z.string().trim().min(1).max(200) }))
  .max(30)
  .refine((items) => new Set(items.map((item) => item.name)).size === items.length, "names must be unique");

const analyticsCatalogSchema = z.strictObject({
  metrics: vocabularySchema.default([]),
  dimensions: vocabularySchema.default([]),
  limitations: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  labels: z.record(z.string().min(1).max(63), z.string().min(1).max(60)).default({}),
  valueLabels: z.record(z.string().min(1).max(200), z.string().min(1).max(40)).default({}),
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/)
    .default("en-US"),
  smallSampleBelow: z.number().int().min(0).max(1_000_000).default(30),
});

const catalogs = new WeakSet();

/**
 * Validates and freezes an analytics catalog. Fails closed: unknown fields, duplicate names, oversized
 * text or an invalid locale throw CONFIG_INVALID.
 * @param {z.input<typeof analyticsCatalogSchema>} input
 */
export function defineAnalyticsCatalog(input = {}) {
  const parsed = analyticsCatalogSchema.safeParse(input);
  if (!parsed.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Analytics catalog is invalid", { details: summarizeZodError(parsed.error, analyticsCatalogSchema) });
  }
  const value = parsed.data;
  const catalog = Object.freeze({
    metrics: Object.freeze(value.metrics.map((item) => Object.freeze({ ...item }))),
    dimensions: Object.freeze(value.dimensions.map((item) => Object.freeze({ ...item }))),
    limitations: Object.freeze([...value.limitations]),
    labels: Object.freeze({ ...value.labels }),
    valueLabels: Object.freeze({ ...value.valueLabels }),
    locale: value.locale,
    smallSampleBelow: value.smallSampleBelow,
  });
  catalogs.add(catalog);
  return catalog;
}

export function isAnalyticsCatalog(value) {
  return typeof value === "object" && value !== null && catalogs.has(value);
}
