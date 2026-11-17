import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AiServiceError, ErrorCodes, summarizeZodError } from "./Errors.js";
import { MAX_GRANTS } from "../constants/AssistantConstants.js";
import { DATA_CLASSIFICATION } from "../enums/DataClassification.js";
export { AI_ASSISTANT_PERMISSION, MAX_GRANTS } from "../constants/AssistantConstants.js";

const DATA_CLASSIFICATIONS = Object.freeze(Object.values(DATA_CLASSIFICATION));

/** Dotted lowercase identifiers such as "ticket.summary". */
export const taskIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

export function classificationRank(classification) {
  return DATA_CLASSIFICATIONS.indexOf(classification);
}

/**
 * Roles and permissions are global across B2Y applications: a role grants named permissions, optionally
 * grouped by module ("Order Management" / "Generate Order Report"), or codes ("VIEW_USERS"); a plan enables
 * features ("ACCESS_ORDER").
 */
export const grantNameSchema = z.string().regex(/^[a-z0-9_]{1,80}(:[a-z0-9_]{1,80})?$/);

const namePart = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * The normalized key of a permission or feature: "Module:Name", a code, or a role row such as
 * { Module, Name } / { module, name } / { code }. Returns null for anything without a name.
 * @param {string | { module?: string, Module?: string, name?: string, Name?: string, code?: string, Code?: string }} value
 */
export function permissionKey(value) {
  let module;
  let name;
  if (typeof value === "string") {
    const colon = value.indexOf(":");
    [module, name] = colon >= 0 ? [value.slice(0, colon), value.slice(colon + 1)] : [undefined, value];
  } else if (value && typeof value === "object") {
    module = value.module ?? value.Module;
    name = value.name ?? value.Name ?? value.code ?? value.Code;
  } else {
    return null;
  }
  const key = namePart(name);
  if (!key) return null;
  const group = module === undefined || module === null ? "" : namePart(module);
  return group ? `${group}:${key}` : key;
}

/** Normalized, de-duplicated keys of a role's permissions (rows or names), ready for context.permissions. */
export function rolePermissions(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(permissionKey).filter(Boolean))];
}

const nameOf = (key) => key.slice(key.indexOf(":") + 1);
const moduleOf = (key) => (key.includes(":") ? key.slice(0, key.indexOf(":")) : null);

/** A granted key satisfies a required key with the same name; modules must match only when both have one. */
function grants(granted, required) {
  return granted.some((key) => key === required || (nameOf(key) === nameOf(required) && (moduleOf(key) === null || moduleOf(required) === null)));
}

const referenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

/** Identity and authorization facts about one AI request: the application context contract. */
export const trustedContextSchema = z.strictObject({
  applicationId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  tenantId: referenceSchema,
  actor: z.strictObject({
    userId: referenceSchema,
  }),
  requestId: referenceSchema,
  permittedTasks: z.array(taskIdSchema).max(100).readonly(),
  dataClassification: dataClassificationSchema,
  permissions: z.array(grantNameSchema).max(MAX_GRANTS).readonly().optional(),
  features: z.array(grantNameSchema).max(MAX_GRANTS).readonly().optional(),
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

/** Validates the context and returns a deep-frozen copy. */
export function parseTrustedContext(value) {
  // Role permissions and plan features arrive as the application stores them; normalize before checking.
  const normalized =
    value && typeof value === "object"
      ? {
          ...value,
          ...(Array.isArray(value.permissions) ? { permissions: value.permissions.map((item) => permissionKey(item) ?? item) } : {}),
          ...(Array.isArray(value.features) ? { features: value.features.map((item) => permissionKey(item) ?? item) } : {}),
        }
      : value;
  const result = trustedContextSchema.safeParse(normalized);
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
 * Access is decided from the trusted context: the role's permissions and the tenant's plan features, both
 * supplied by the application from its own session. The model never grants anything. A context without
 * `permissions` or `features` grants none.
 *
 * A requirement lists what is needed: `permission` and `feature` each take one name or a list meaning
 * "any of these". Both must be met when both are given.
 * @typedef {{ permission?: string | string[], feature?: string | string[] }} Requirement
 */

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Validates and normalizes a requirement at setup time, so a typo fails at startup rather than per request. */
export function checkRequirement(requirement, where) {
  if (requirement === undefined) return Object.freeze({});
  const { permission, feature, ...rest } = requirement ?? {};
  const permissions = asList(permission).map(permissionKey);
  const features = asList(feature).map(permissionKey);
  const invalid =
    typeof requirement !== "object" ||
    requirement === null ||
    Object.keys(rest).length > 0 ||
    [...permissions, ...features].some((key) => key === null || !grantNameSchema.safeParse(key).success) ||
    (permission !== undefined && permissions.length === 0) ||
    (feature !== undefined && features.length === 0);
  if (invalid) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, `${where}: a requirement is { permission?, feature? }, each a name or a list of names`);
  return Object.freeze({
    ...(permissions.length ? { permission: Object.freeze(permissions) } : {}),
    ...(features.length ? { feature: Object.freeze(features) } : {}),
  });
}

/**
 * Whether a parsed context meets a checked requirement, and if not, what is missing ("permission" is
 * reported before "feature").
 * @returns {{ ok: boolean, missing: "permission" | "feature" | null }}
 */
export function meetsRequirement(context, requirement) {
  const permitted = !requirement.permission || requirement.permission.some((key) => grants(context.permissions ?? [], key));
  if (!permitted) return { ok: false, missing: "permission" };
  const enabled = !requirement.feature || requirement.feature.some((key) => grants(context.features ?? [], key));
  return enabled ? { ok: true, missing: null } : { ok: false, missing: "feature" };
}

/** Whether the context's role grants this permission (any of a list). */
export function hasPermission(context, permission) {
  return meetsRequirement(parseTrustedContext(context), checkRequirement({ permission }, "hasPermission")).ok;
}

/** Whether the tenant's plan enables this feature (any of a list). */
export function hasFeature(context, feature) {
  return meetsRequirement(parseTrustedContext(context), checkRequirement({ feature }, "hasFeature")).ok;
}

/**
 * Throws NOT_AUTHORIZED or FEATURE_NOT_ENABLED unless the context meets the requirement. Returns the
 * parsed, frozen context. Error details name the requirement, never the context's other grants.
 * @param {TrustedContextInput} context
 * @param {Requirement} requirement
 */
export function assertAuthorized(context, requirement = {}) {
  const parsed = parseTrustedContext(context);
  const checked = checkRequirement(requirement, "assertAuthorized");
  const { missing } = meetsRequirement(parsed, checked);
  if (missing === "permission") {
    throw new AiServiceError(ErrorCodes.NOT_AUTHORIZED, "The request is not authorized for this operation", { details: { permission: checked.permission.join("|").slice(0, 200) } });
  }
  if (missing === "feature") {
    throw new AiServiceError(ErrorCodes.FEATURE_NOT_ENABLED, "This feature is not enabled for the tenant", { details: { feature: checked.feature.join("|").slice(0, 200) } });
  }
  return parsed;
}

/**
 * The global tenant rule: the tenant the request arrived for (resolved from its domain) must be present and be
 * the tenant of the signed-in session (token). Returns the verified tenant id; throws TENANT_MISMATCH.
 * @param {{ requestTenantId: unknown, sessionTenantId: unknown }} tenants
 */
export function resolveTenantId({ requestTenantId, sessionTenantId }) {
  const present = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  if (!present(requestTenantId) || !present(sessionTenantId) || String(requestTenantId) !== String(sessionTenantId)) {
    throw new AiServiceError(ErrorCodes.TENANT_MISMATCH, "The session does not belong to the tenant of this request");
  }
  return String(requestTenantId);
}

/**
 * The trusted context for one request, built the same way in every application: the verified tenant (from
 * the request and session tenants, or a fixed scope for applications without tenants), the signed-in user,
 * the role's permissions and the plan's features as stored, and the tasks the assistant may run.
 * @param {{ applicationId: string, requestTenantId?: unknown, sessionTenantId?: unknown, scope?: string, userId: unknown,
 *   permissions?: unknown[], features?: unknown[], tasks: readonly ({ id: string } | string)[], dataClassification?: string, requestId?: string }} options
 */
export function buildTrustedContext({ applicationId, requestTenantId, sessionTenantId, scope, userId, permissions = [], features = [], tasks, dataClassification = DATA_CLASSIFICATION.INTERNAL, requestId = randomUUID() }) {
  const tenantId = scope === undefined ? resolveTenantId({ requestTenantId, sessionTenantId }) : String(scope);
  if (userId === undefined || userId === null || String(userId) === "") throw new AiServiceError(ErrorCodes.CONTEXT_INVALID, "A signed-in user is required");
  return parseTrustedContext({
    applicationId,
    tenantId,
    actor: { userId: String(userId) },
    requestId,
    permittedTasks: (tasks ?? []).map((task) => (typeof task === "string" ? task : task.id)),
    dataClassification,
    permissions: rolePermissions(permissions),
    features: rolePermissions(features),
  });
}

/** An authorization refusal decided by the application (for example an inactive user), handled like the package's own. */
export function accessDenied(reason) {
  return new AiServiceError(ErrorCodes.NOT_AUTHORIZED, String(reason ?? "Access denied").slice(0, 200));
}
