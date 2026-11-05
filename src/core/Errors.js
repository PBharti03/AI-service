import { z } from "zod";

/** Every code an AiServiceError can carry. */
export const ErrorCodes = {
  CONFIG_INVALID: "CONFIG_INVALID",
  CONTEXT_INVALID: "CONTEXT_INVALID",
  TASK_UNKNOWN: "TASK_UNKNOWN",
  TASK_NOT_PERMITTED: "TASK_NOT_PERMITTED",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  FEATURE_NOT_ENABLED: "FEATURE_NOT_ENABLED",
  CLASSIFICATION_NOT_ALLOWED: "CLASSIFICATION_NOT_ALLOWED",
  INPUT_INVALID: "INPUT_INVALID",
  REQUEST_TOO_LARGE: "REQUEST_TOO_LARGE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_HTTP_ERROR: "PROVIDER_HTTP_ERROR",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_OUTPUT_REJECTED: "PROVIDER_OUTPUT_REJECTED",
  PROVIDER_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID",
  CANCELLED: "CANCELLED",
  OUTPUT_PARSE_FAILED: "OUTPUT_PARSE_FAILED",
  OUTPUT_SCHEMA_INVALID: "OUTPUT_SCHEMA_INVALID",
  OUTPUT_REJECTED: "OUTPUT_REJECTED",
  DOCUMENT_SOURCE_INVALID: "DOCUMENT_SOURCE_INVALID",
  DOCUMENT_SOURCE_FAILED: "DOCUMENT_SOURCE_FAILED",
  CAPABILITY_FAILED: "CAPABILITY_FAILED",
  CAPABILITY_TIMEOUT: "CAPABILITY_TIMEOUT",
  USAGE_RECORDING_FAILED: "USAGE_RECORDING_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * What kind of failure a code is, so consumers can map errors to responses without listing codes:
 *   configuration  the consumer's setup is invalid (fix the code or config; never retried)
 *   context        the trusted context is malformed
 *   authorization  the context does not permit this (task, permission, feature or data classification)
 *   validation     the request or tool input is invalid
 *   provider       the model provider failed or returned something unusable
 *   rate_limit     the provider's rate limit was reached (retry later)
 *   output         the model's output failed validation
 *   execution      a consumer-supplied executor (tool, document source) failed or returned invalid data
 *   cancelled      the caller cancelled
 *   internal       a bug or an unexpected failure
 */
export const ErrorCategories = Object.freeze({
  CONFIG_INVALID: "configuration",
  CONTEXT_INVALID: "context",
  TASK_UNKNOWN: "configuration",
  TASK_NOT_PERMITTED: "authorization",
  NOT_AUTHORIZED: "authorization",
  FEATURE_NOT_ENABLED: "authorization",
  CLASSIFICATION_NOT_ALLOWED: "authorization",
  INPUT_INVALID: "validation",
  REQUEST_TOO_LARGE: "validation",
  PROVIDER_TIMEOUT: "provider",
  PROVIDER_UNAVAILABLE: "provider",
  PROVIDER_HTTP_ERROR: "provider",
  PROVIDER_RATE_LIMITED: "rate_limit",
  PROVIDER_OUTPUT_REJECTED: "output",
  PROVIDER_RESPONSE_INVALID: "provider",
  CANCELLED: "cancelled",
  OUTPUT_PARSE_FAILED: "output",
  OUTPUT_SCHEMA_INVALID: "output",
  OUTPUT_REJECTED: "output",
  DOCUMENT_SOURCE_INVALID: "execution",
  DOCUMENT_SOURCE_FAILED: "execution",
  CAPABILITY_FAILED: "execution",
  CAPABILITY_TIMEOUT: "execution",
  USAGE_RECORDING_FAILED: "internal",
  INTERNAL_ERROR: "internal",
});

/**
 * @typedef {string | number | boolean} ErrorDetailValue
 */

/**
 * @typedef {Readonly<Record<string, ErrorDetailValue>>} ErrorDetails
 */

/**
 * @typedef {Object} AiServiceErrorOptions
 * @property {boolean} [retryable]
 * @property {ErrorDetails} [details]
 * @property {unknown} [cause] - Underlying error. Only its type name and a well-formed error code are kept (see SafeErrorCause).
 */

/**
 * What remains of an underlying error. Raw errors are never retained because their messages can quote secrets or content: a header error quotes the header value, a JSON SyntaxError quotes the parsed text, and errors thrown by application hooks can contain anything.
 * @typedef {Object} SafeErrorCause
 * @property {string} name
 * @property {string} [code]
 */

/**
 * What remains of an underlying error. Raw errors are never retained because
 * their messages can quote secrets or content: a header error quotes the
 * header value, a JSON SyntaxError quotes the parsed text, and errors thrown
 * by application hooks can contain anything.
 */

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The only error type the package throws.
 *
 * `message`, `details` and `cause` are built by this package from metadata
 * only (codes, counts, HTTP status, schema-declared paths, error type names),
 * so the error can be logged or inspected without exposing prompts, model
 * output, provider response bodies or credentials. This holds for errors the
 * package creates; an AiServiceError constructed by application code carries
 * whatever that code put in it.
 */
export class AiServiceError extends Error {
  code;
  retryable;
  details;

  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: toSafeCause(options.cause) });
    this.name = "AiServiceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...options.details });
  }
}

export function createCancelledError() {
  return new AiServiceError(ErrorCodes.CANCELLED, "The AI request was cancelled");
}

/** Wraps anything that is not already an AiServiceError, keeping only a safe summary of it. */
export function toAiServiceError(error) {
  if (error instanceof AiServiceError) {
    return error;
  }
  return new AiServiceError(ErrorCodes.INTERNAL_ERROR, "Unexpected error while running the AI task", {
    cause: error,
  });
}

/**
 * Returns a well-formed system error code (for example ECONNREFUSED or
 * UND_ERR_SOCKET) from the error or its direct cause, or undefined.
 */
export function systemErrorCode(error) {
  for (const candidate of [error, causeOf(error)]) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const code = candidate.code;
      if (typeof code === "string" && SAFE_CODE.test(code)) {
        return code;
      }
    }
  }
  return undefined;
}

function causeOf(error) {
  return error instanceof Error ? error.cause : undefined;
}

function toSafeCause(cause) {
  if (cause instanceof AiServiceError) {
    return Object.freeze({ name: cause.name, code: cause.code });
  }
  const name = cause instanceof Error && SAFE_NAME.test(cause.name) ? cause.name : typeof cause;
  const code = systemErrorCode(cause);
  return Object.freeze(code === undefined ? { name } : { name, code });
}

/**
 * The category of an error (see ErrorCategories): "rate_limit", "authorization", "provider" ... and
 * "internal" for anything that is not an AiServiceError.
 */
export function errorCategory(error) {
  return error instanceof AiServiceError && Object.hasOwn(ErrorCategories, error.code) ? ErrorCategories[error.code] : "internal";
}

/** Shown to users on a rate limit; the provider's wait belongs in logs (rateLimitInfo). */
export const AI_BUSY_MESSAGE = "AI is temporarily busy. Please try again shortly.";

export function isRateLimited(error) {
  return error instanceof AiServiceError && error.code === ErrorCodes.PROVIDER_RATE_LIMITED;
}

/**
 * Rate-limit details for logs and metadata; cooldown is true when the provider was not called.
 * @returns {{ status: number, retryAfterSeconds: number | null, cooldown: boolean } | null}
 */
export function rateLimitInfo(error) {
  if (!isRateLimited(error)) return null;
  const seconds = Number(error.details.retryAfterSeconds);
  return { status: 429, retryAfterSeconds: Number.isFinite(seconds) ? seconds : null, cooldown: error.details.cooldown === true };
}

/** The message to show a user for an AI error: AI_BUSY_MESSAGE for rate limits, otherwise the fallback. */
export function aiUserMessage(error, fallback) {
  return isRateLimited(error) ? AI_BUSY_MESSAGE : fallback;
}

const MAX_REPORTED_ISSUES = 5;

/** Placeholder for a path segment that is not a property name declared by the schema. */
export const REDACTED_SEGMENT = "*";

const declaredKeysCache = new WeakMap();

/**
 * Reduces a ZodError to issue counts, codes and paths that are safe to log.
 *
 * Received values are never included. Path segments are kept only when they
 * are array indices or property names declared by the schema; any other key
 * (for example a key of a z.record, which comes from the data) is replaced
 * with "*".
 */
export function summarizeZodError(error, schema) {
  const declared = declaredKeys(schema);
  const paths = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) =>
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

function declaredKeys(schema) {
  const cached = declaredKeysCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const keys = new Set();
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

function collectPropertyNames(node, into) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyNames(item, into);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const entries = Object.entries(node);
  for (const [keyword, value] of entries) {
    if (keyword === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        into.add(name);
      }
    }
    collectPropertyNames(value, into);
  }
}
