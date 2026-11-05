// Public API of @b2y/ai-service. Only what is listed here (and in the package.json "exports" subpaths)
// is supported; everything else under src/ is internal and may change without notice.
// tests/unit/PublicApi.test.js pins this list so nothing becomes public by accident.

// ── Core: tasks, the AI service and its configuration ─────────────────────────
export { createAiService } from "./core/CreateAiService.js";
export { noopLogger } from "./core/Logger.js";
export { defineTask } from "./tasks/DefineTask.js";
export { createTaskRegistry } from "./tasks/TaskRegistry.js";

// ── Application context (supplied by the consumer) and authorization checks ───
export { DATA_CLASSIFICATIONS } from "./context/DataClassification.js";
export { parseTrustedContext } from "./context/TrustedContext.js";
export { assertAuthorized, hasFeature, hasPermission } from "./context/Authorization.js";

// ── Errors ────────────────────────────────────────────────────────────────────
export { AiServiceError, errorCategory } from "./errors/AiServiceError.js";
export { ErrorCategories, ErrorCodes } from "./errors/ErrorCodes.js";

// ── Providers (all behind the ChatProvider interface) ─────────────────────────
export { createGroqProvider, createProvider, GROQ_BASE_URL, PROVIDER_TYPES } from "./providers/ProviderFactory.js";
export { createOllamaProvider, OLLAMA_DEFAULT_TIMEOUT_MS } from "./providers/OllamaProvider.js";
export {
  createOpenAICompatibleProvider,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "./providers/OpenAICompatibleProvider.js";
export { APPROVED_PAID_HOSTS } from "./providers/EndpointPolicy.js";

// ── Tools (read-only, consumer-implemented) ───────────────────────────────────
export { defineTool, isTool } from "./tools/DefineTool.js";
export { createToolRegistry } from "./tools/ToolRegistry.js";

// ── SQL policy and validation (dialect validators: "@b2y/ai-service/text-to-sql/postgres") ──
export {
  defineSqlPolicy,
  isSqlPolicy,
  SQL_AGGREGATE_FUNCTIONS,
  SQL_COLUMN_TYPES,
  SQL_DIALECTS,
  SQL_SAFE_FUNCTIONS,
  SQL_SAFE_WINDOW_FUNCTIONS,
} from "./text-to-sql/SqlPolicy.js";
export { isValidatedQuery, SqlValidationCodes } from "./text-to-sql/SqlValidation.js";
export { checkQueryResult } from "./text-to-sql/ResultGuard.js";
export { buildSchemaContext, describePolicyRules } from "./text-to-sql/SchemaContext.js";
export { CHART_HINTS, MAX_CONVERSATION_TURNS, TEXT_TO_SQL_TASK, TEXT_TO_SQL_TASK_ID } from "./text-to-sql/TextToSqlTask.js";
export { createTextToSqlAgent } from "./text-to-sql/TextToSqlAgent.js";

// ── Analytics (multi-query, consumer-supplied catalog, policy and executor) ───
export { defineAnalyticsCatalog, isAnalyticsCatalog } from "./analytics/AnalyticsCatalog.js";
export {
  ANALYTICS_PLAN_TASK,
  ANALYTICS_PLAN_TASK_ID,
  MAX_PLAN_CONVERSATION_TURNS,
  MAX_PLAN_QUERIES,
} from "./analytics/AnalyticsPlanTask.js";
export { ANALYTICS_LIMITS, createAnalyticsAssistant } from "./analytics/AnalyticsAssistant.js";
export { createAnalyticsRouter } from "./analytics/AnalyticsRouting.js";
export { mergeSections, observeSection } from "./analytics/ResultAnalysis.js";
export { buildResultChart, CHART_TYPES, chartSpecSchema } from "./analytics/ResultChart.js";

// ── Application profile and chat ──────────────────────────────────────────────
export { defineApplicationProfile, isApplicationProfile } from "./assistant/ApplicationProfile.js";
export {
  ASSISTANT_CHAT_TASK,
  ASSISTANT_CHAT_TASK_ID,
  createChatAssistant,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_MESSAGE_CHARS,
} from "./assistant/AssistantChatTask.js";

// ── Documents (consumer-supplied source; filesystem store: "@b2y/ai-service/documents/folder") ──
export { createIndexDocumentSource, defineDocumentSource, isDocumentSource, MAX_PASSAGE_CHARS } from "./documents/DocumentSource.js";
export { buildSearchIndex, searchIndex, splitIntoPassages } from "./documents/DocumentSearch.js";
export { createDocumentQaAgent, DOCUMENT_ANSWER_TASK, DOCUMENT_ANSWER_TASK_ID } from "./documents/DocumentQaAgent.js";

// ── Assistant (copilot): capabilities, routing, research and answers ──────────
export { createAiAssistant } from "./copilot/AiAssistant.js";
export { CAPABILITY_KINDS, createAnalyticsCapability, createDocumentsCapability, defineCapability, isCapability } from "./copilot/Capability.js";
export { ASSISTANT_RESPOND_TASK, ASSISTANT_RESPOND_TASK_ID, ASSISTANT_ROUTE_TASK, ASSISTANT_ROUTE_TASK_ID } from "./copilot/CopilotTasks.js";
export { defineResearchProvider, isResearchProvider } from "./copilot/Research.js";
export { analyticsReportToBlocks, responseBlocksSchema } from "./copilot/ResponseBlocks.js";

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
