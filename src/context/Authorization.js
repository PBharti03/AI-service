import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { grantNameSchema, parseTrustedContext } from "./TrustedContext.js";

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
