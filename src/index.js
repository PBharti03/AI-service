// Public API of @b2y/ai-service.

export { AI_PROVIDER_CONFIG, createAiService, createDefaultAiService } from "./core/AiService.js";
export { noopLogger } from "./core/AiService.js";
export { defineTask } from "./core/Tasks.js";
export { createTaskRegistry } from "./core/Tasks.js";

export { parseTrustedContext } from "./core/Context.js";
export { AI_ASSISTANT_PERMISSION, accessDenied, assertAuthorized, buildTrustedContext, hasFeature, hasPermission, permissionKey, resolveTenantId, rolePermissions } from "./core/Context.js";
export { ASSISTANT_NAME } from "./constants/AssistantConstants.js";
export { DATA_CLASSIFICATION } from "./enums/DataClassification.js";
export { RESPONSE_STATUS } from "./constants/ServerConstants.js";

export { AiServiceError, errorCategory } from "./core/Errors.js";
export { ErrorCategories, ErrorCodes } from "./core/Errors.js";
export { aiUserMessage, isRateLimited, rateLimitInfo } from "./core/Errors.js";

// Providers are internal: AI_PROVIDER_CONFIG (constants/ProviderConstants.js) is the one place that picks provider and model.

export {
  defineSqlPolicy,
  isSqlPolicy,
  SQL_SAFE_FUNCTIONS,
  SQL_SAFE_WINDOW_FUNCTIONS,
} from "./sql/SqlPolicy.js";
export { isValidatedQuery, SqlValidationCodes } from "./sql/SqlPolicy.js";
export { checkQueryResult } from "./sql/SqlPolicy.js";
export { buildSchemaContext, describePolicyRules } from "./sql/SqlPolicy.js";

export { defineAnalyticsCatalog, isAnalyticsCatalog } from "./analytics/Analytics.js";
export { ANALYTICS_PLAN_TASK } from "./analytics/Analytics.js";
export { createAnalyticsAssistant } from "./analytics/Analytics.js";
export { mergeSections, observeSection } from "./analytics/Results.js";
export { buildResultChart, CHART_TYPES, chartSpecSchema } from "./analytics/Results.js";

export { defineApplicationProfile, isApplicationProfile } from "./assistant/Assistant.js";

export { createIndexDocumentSource, defineDocumentSource, isDocumentSource } from "./documents/Documents.js";
export { buildSearchIndex, searchIndex, splitIntoPassages } from "./documents/Documents.js";
export { createDocumentQaAgent, DOCUMENT_ANSWER_TASK } from "./documents/Documents.js";

export { createAiAssistant } from "./assistant/Assistant.js";
export { CAPABILITY_KINDS, createAnalyticsCapability, createDocumentsCapability, defineCapability, isCapability } from "./assistant/Capabilities.js";
export { createSearchCapability, SEARCH_FILTERS_TASK } from "./assistant/Capabilities.js";
export { ASSISTANT_RESPOND_TASK, ASSISTANT_ROUTE_TASK } from "./assistant/Assistant.js";
export { analyticsReportToBlocks, responseBlocksSchema } from "./assistant/Capabilities.js";

export {
  createConversationHistory,
  defineConversationStore,
  isConversationStore,
  scheduleConversationCleanup,
} from "./conversations/ConversationHistory.js";
