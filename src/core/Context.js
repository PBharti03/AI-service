import { z } from "zod";
import { AiServiceError, ErrorCodes, summarizeZodError } from "./Errors.js";

/** Dotted lowercase identifiers such as "ticket.summary". */
export const taskIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);

/** Ordered from least to most sensitive. */
export const DATA_CLASSIFICATIONS = ["SYNTHETIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

export function classificationRank(classification) {
  return DATA_CLASSIFICATIONS.indexOf(classification);
}

/**
 * A permission or feature name the consumer grants, for example "analytics:read" or "documents".
 * Opaque to this package: it only checks that a required name is present.
 */
export const grantNameSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/);

const referenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

/**
 * Identity and authorization facts about one AI request: the application context contract.
 *
 * The application backend builds this from its own authenticated session and
 * authorization checks. This package only validates the shape: it never
 * authenticates anyone, never grants permissions, and never reads identity
 * from prompts, task input or model output.
 *
 *   applicationId       which application the request belongs to (isolates profiles and documents)
 *   tenantId            the consumer's tenant (passed to tools and document sources for scoping)
 *   actor               the authenticated user, or SYSTEM for background work
 *   requestId           correlation id for logs and usage records
 *   permittedTasks      AI tasks this request may run (decided by the consumer)
 *   dataClassification  the most sensitive data the request may send to the model
 *   permissions         optional: permission names the consumer granted for this request
 *   features            optional: subscription or plan features enabled for the tenant
 *   metadata            optional: locale and channel
 */
export const trustedContextSchema = z.strictObject({
  applicationId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  tenantId: referenceSchema,
  actor: z.strictObject({
    type: z.enum(["USER", "SYSTEM"]),
    userId: referenceSchema,
  }),
  requestId: referenceSchema,
  permittedTasks: z.array(taskIdSchema).max(100).readonly(),
  dataClassification: dataClassificationSchema,
  permissions: z.array(grantNameSchema).max(100).readonly().optional(),
  features: z.array(grantNameSchema).max(100).readonly().optional(),
  metadata: z
    .strictObject({
      locale: z
        .string()
        .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
        .optional(),
      channel: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,31}$/)
        .optional(),
    })
    .optional(),
});

/**
 * Validates the context and returns a deep-frozen copy. Freezing keeps the
 * validated tenant and actor identity fixed for the whole task, including
 * when the context is passed to application hooks and used for usage records.
 */
export function parseTrustedContext(value) {
  const result = trustedContextSchema.safeParse(value);
  if (!result.success) {
    throw new AiServiceError(ErrorCodes.CONTEXT_INVALID, "Trusted context is invalid", {
      details: summarizeZodError(result.error, trustedContextSchema),
    });
  }
  const { actor, permittedTasks, permissions, features, metadata, ...rest } = result.data;
  return Object.freeze({
    ...rest,
    actor: Object.freeze({ ...actor }),
    permittedTasks: Object.freeze([...permittedTasks]),
    ...(permissions === undefined ? {} : { permissions: Object.freeze([...new Set(permissions)]) }),
    ...(features === undefined ? {} : { features: Object.freeze([...new Set(features)]) }),
    ...(metadata === undefined ? {} : { metadata: Object.freeze({ ...metadata }) }),
  });
}

/**
 * Checks against what the consumer granted in the trusted context. This is not RBAC: the package never
 * decides who may do what; it only refuses when a name the feature requires is missing from the
 * consumer's own lists. A context without `permissions` or `features` grants none.
 */

/** @typedef {{ permission?: string, feature?: string }} Requirement */

/** Validates a requirement at setup time, so a typo fails at startup rather than per request. */
export function checkRequirement(requirement, where) {
  if (requirement === undefined) return Object.freeze({});
  const { permission, feature, ...rest } = requirement ?? {};
  const invalid =
    typeof requirement !== "object" ||
    requirement === null ||
    Object.keys(rest).length > 0 ||
    (permission !== undefined && !grantNameSchema.safeParse(permission).success) ||
    (feature !== undefined && !grantNameSchema.safeParse(feature).success);
  if (invalid) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, `${where}: a requirement is { permission?, feature? } with valid names`);
  return Object.freeze({ ...(permission === undefined ? {} : { permission }), ...(feature === undefined ? {} : { feature }) });
}

/** Whether the context grants this permission. */
export function hasPermission(context, permission) {
  const parsed = parseTrustedContext(context);
  return (parsed.permissions ?? []).includes(permission);
}

/** Whether the tenant has this feature enabled. */
export function hasFeature(context, feature) {
  const parsed = parseTrustedContext(context);
  return (parsed.features ?? []).includes(feature);
}

/**
 * Throws NOT_AUTHORIZED or FEATURE_NOT_ENABLED unless the context grants what is required. Returns the
 * parsed, frozen context. Error details name the requirement, never the context's other grants.
 * @param {TrustedContextInput} context
 * @param {Requirement} requirement
 */
export function assertAuthorized(context, requirement = {}) {
  const parsed = parseTrustedContext(context);
  if (requirement.permission !== undefined && !(parsed.permissions ?? []).includes(requirement.permission)) {
    throw new AiServiceError(ErrorCodes.NOT_AUTHORIZED, "The request is not authorized for this operation", {
      details: { permission: requirement.permission },
    });
  }
  if (requirement.feature !== undefined && !(parsed.features ?? []).includes(requirement.feature)) {
    throw new AiServiceError(ErrorCodes.FEATURE_NOT_ENABLED, "This feature is not enabled for the tenant", {
      details: { feature: requirement.feature },
    });
  }
  return parsed;
}
