// Public API of @b2y/ai-service. Only what is listed here (and in the package.json "exports" subpaths)
// is supported; everything else under src/ is internal and may change without notice.
// tests/unit/PublicApi.test.js pins this list so nothing becomes public by accident.

// ── Core: tasks, the AI service and its configuration ─────────────────────────
export { createAiService } from "./core/AiService.js";
export { noopLogger } from "./core/AiService.js";
export { defineTask } from "./core/Tasks.js";
export { createTaskRegistry } from "./core/Tasks.js";

// ── Application context (supplied by the consumer) and authorization checks ───
export { DATA_CLASSIFICATIONS } from "./core/Context.js";
export { parseTrustedContext } from "./core/Context.js";
export { assertAuthorized, hasFeature, hasPermission } from "./core/Context.js";

// ── Errors ────────────────────────────────────────────────────────────────────
export { AiServiceError, errorCategory } from "./core/Errors.js";
export { ErrorCategories, ErrorCodes } from "./core/Errors.js";
export { AI_BUSY_MESSAGE, aiUserMessage, isRateLimited, rateLimitInfo } from "./core/Errors.js";

// ── Providers (all behind the ChatProvider interface) ─────────────────────────
export { createGroqProvider, createProvider, GROQ_BASE_URL, GROQ_DEFAULT_MODEL, PROVIDER_TYPES } from "./providers/Providers.js";
export {
  createOpenAICompatibleProvider,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "./providers/Providers.js";
export { APPROVED_PAID_HOSTS } from "./providers/Providers.js";

// ── SQL policy and validation (dialect validators: "@b2y/ai-service/text-to-sql/postgres") ──
export {
  defineSqlPolicy,
  isSqlPolicy,
  SQL_AGGREGATE_FUNCTIONS,
  SQL_COLUMN_TYPES,
  SQL_DIALECTS,
  SQL_SAFE_FUNCTIONS,
  SQL_SAFE_WINDOW_FUNCTIONS,
} from "./sql/SqlPolicy.js";
export { isValidatedQuery, SqlValidationCodes } from "./sql/SqlPolicy.js";
export { checkQueryResult } from "./sql/SqlPolicy.js";
export { buildSchemaContext, describePolicyRules } from "./sql/SqlPolicy.js";

// ── Analytics (multi-query, consumer-supplied catalog, policy and executor) ───
export { defineAnalyticsCatalog, isAnalyticsCatalog } from "./analytics/Analytics.js";
export {
  ANALYTICS_PLAN_TASK,
  ANALYTICS_PLAN_TASK_ID,
  CHART_HINTS,
  MAX_PLAN_CONVERSATION_TURNS,
  MAX_PLAN_QUERIES,
} from "./analytics/Analytics.js";
export { ANALYTICS_LIMITS, createAnalyticsAssistant } from "./analytics/Analytics.js";
export { mergeSections, observeSection } from "./analytics/Results.js";
export { buildResultChart, CHART_TYPES, chartSpecSchema } from "./analytics/Results.js";

// ── Application profile ──────────────────────────────────────────────
export { defineApplicationProfile, isApplicationProfile } from "./copilot/Assistant.js";

// ── Documents (consumer-supplied source; filesystem store: "@b2y/ai-service/documents/folder") ──
export { createIndexDocumentSource, defineDocumentSource, isDocumentSource, MAX_PASSAGE_CHARS } from "./documents/Documents.js";
export { buildSearchIndex, searchIndex, splitIntoPassages } from "./documents/Documents.js";
export { createDocumentQaAgent, DOCUMENT_ANSWER_TASK, DOCUMENT_ANSWER_TASK_ID } from "./documents/Documents.js";

// ── Assistant (copilot): capabilities, routing and answers ──
export { createAiAssistant } from "./copilot/Assistant.js";
export { CAPABILITY_KINDS, createAnalyticsCapability, createDocumentsCapability, defineCapability, isCapability } from "./copilot/Capabilities.js";
export { ASSISTANT_RESPOND_TASK, ASSISTANT_RESPOND_TASK_ID, ASSISTANT_ROUTE_TASK, ASSISTANT_ROUTE_TASK_ID } from "./copilot/Assistant.js";
export { analyticsReportToBlocks, responseBlocksSchema } from "./copilot/Capabilities.js";

// ── Conversation history and retention (local file store: "@b2y/ai-service/conversations/folder") ──
export {
  APP_DATA_MAX_BYTES,
  createConversationHistory,
  createMemoryConversationStore,
  DEFAULT_RETENTION_DAYS,
  defineConversationStore,
  isConversationStore,
  MAX_RETENTION_DAYS,
  scheduleConversationCleanup,
} from "./conversations/ConversationHistory.js";
