/**
 * Token counts as reported by the provider; null when it did not report them.
 * @typedef {Object} TokenUsage
 * @property {number | null} promptTokens
 * @property {number | null} completionTokens
 * @property {number | null} totalTokens
 */

/**
 * Also has every field of TokenUsage.
 * @typedef {Object} TaskUsage
 * @property {number} latencyMs
 * @property {number} attempts - Provider calls made, including retries. 0 when the task failed before calling the provider.
 */

/**
 * Metadata-only record for metering and quotas. Contains no prompt or output content.
 * @typedef {Object} UsageRecord
 * @property {string} applicationId
 * @property {string} tenantId
 * @property {"USER" | "SYSTEM"} actorType
 * @property {string} userId
 * @property {string} requestId
 * @property {string} taskId
 * @property {number} taskVersion
 * @property {string} promptVersion
 * @property {string} providerId
 * @property {string} model
 * @property {"SUCCESS" | "FAILURE"} outcome
 * @property {ErrorCode | null} errorCode
 * @property {TaskUsage} usage
 */

/** Token counts as reported by the provider; null when it did not report them. */

/** Metadata-only record for metering and quotas. Contains no prompt or output content. */

export const EMPTY_TOKEN_USAGE = Object.freeze({
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
});
