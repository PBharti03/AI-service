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
  TOOL_UNKNOWN: "TOOL_UNKNOWN",
  TOOL_INPUT_INVALID: "TOOL_INPUT_INVALID",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  TOOL_RESULT_INVALID: "TOOL_RESULT_INVALID",
  DOCUMENT_SOURCE_INVALID: "DOCUMENT_SOURCE_INVALID",
  DOCUMENT_SOURCE_FAILED: "DOCUMENT_SOURCE_FAILED",
  CAPABILITY_FAILED: "CAPABILITY_FAILED",
  CAPABILITY_TIMEOUT: "CAPABILITY_TIMEOUT",
  RESEARCH_FAILED: "RESEARCH_FAILED",
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
  TOOL_UNKNOWN: "validation",
  TOOL_INPUT_INVALID: "validation",
  TOOL_TIMEOUT: "execution",
  TOOL_EXECUTION_FAILED: "execution",
  TOOL_RESULT_INVALID: "execution",
  DOCUMENT_SOURCE_INVALID: "execution",
  DOCUMENT_SOURCE_FAILED: "execution",
  CAPABILITY_FAILED: "execution",
  CAPABILITY_TIMEOUT: "execution",
  RESEARCH_FAILED: "execution",
  USAGE_RECORDING_FAILED: "internal",
  INTERNAL_ERROR: "internal",
});
