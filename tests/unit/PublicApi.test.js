// Pins the public API: adding or removing a root export must be a deliberate change to this list.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as api from "../../src/index.js";

const ROOT_EXPORTS = [
  "analyticsReportToBlocks",
  "APP_DATA_MAX_BYTES",
  "ASSISTANT_RESPOND_TASK",
  "ASSISTANT_RESPOND_TASK_ID",
  "ASSISTANT_ROUTE_TASK",
  "ASSISTANT_ROUTE_TASK_ID",
  "CAPABILITY_KINDS",
  "createAiAssistant",
  "createAnalyticsCapability",
  "createConversationHistory",
  "createDocumentsCapability",
  "createMemoryConversationStore",
  "DEFAULT_RETENTION_DAYS",
  "defineCapability",
  "defineConversationStore",
  "defineResearchProvider",
  "isCapability",
  "isConversationStore",
  "isResearchProvider",
  "MAX_RETENTION_DAYS",
  "responseBlocksSchema",
  "scheduleConversationCleanup",
  "AiServiceError",
  "ANALYTICS_LIMITS",
  "ANALYTICS_PLAN_TASK",
  "ANALYTICS_PLAN_TASK_ID",
  "APPROVED_PAID_HOSTS",
  "assertAuthorized",
  "ASSISTANT_CHAT_TASK",
  "ASSISTANT_CHAT_TASK_ID",
  "buildResultChart",
  "buildSchemaContext",
  "buildSearchIndex",
  "CHART_HINTS",
  "CHART_TYPES",
  "chartSpecSchema",
  "checkQueryResult",
  "createAiService",
  "createAnalyticsAssistant",
  "createAnalyticsRouter",
  "createChatAssistant",
  "createDocumentQaAgent",
  "createGroqProvider",
  "createIndexDocumentSource",
  "createOllamaProvider",
  "createOpenAICompatibleProvider",
  "createProvider",
  "createTaskRegistry",
  "createTextToSqlAgent",
  "createToolRegistry",
  "DATA_CLASSIFICATIONS",
  "DEFAULT_MAX_REQUEST_BYTES",
  "DEFAULT_MAX_RESPONSE_BYTES",
  "defineAnalyticsCatalog",
  "defineApplicationProfile",
  "defineDocumentSource",
  "defineSqlPolicy",
  "defineTask",
  "defineTool",
  "describePolicyRules",
  "DOCUMENT_ANSWER_TASK",
  "DOCUMENT_ANSWER_TASK_ID",
  "ErrorCategories",
  "errorCategory",
  "ErrorCodes",
  "GROQ_BASE_URL",
  "hasFeature",
  "hasPermission",
  "isAnalyticsCatalog",
  "isApplicationProfile",
  "isDocumentSource",
  "isSqlPolicy",
  "isTool",
  "isValidatedQuery",
  "MAX_CHAT_HISTORY_MESSAGES",
  "MAX_CHAT_MESSAGE_CHARS",
  "MAX_CONVERSATION_TURNS",
  "MAX_PASSAGE_CHARS",
  "MAX_PLAN_CONVERSATION_TURNS",
  "MAX_PLAN_QUERIES",
  "mergeSections",
  "noopLogger",
  "observeSection",
  "OLLAMA_DEFAULT_TIMEOUT_MS",
  "parseTrustedContext",
  "PROVIDER_TYPES",
  "searchIndex",
  "splitIntoPassages",
  "SQL_AGGREGATE_FUNCTIONS",
  "SQL_COLUMN_TYPES",
  "SQL_DIALECTS",
  "SQL_SAFE_FUNCTIONS",
  "SQL_SAFE_WINDOW_FUNCTIONS",
  "SqlValidationCodes",
  "TEXT_TO_SQL_TASK",
  "TEXT_TO_SQL_TASK_ID",
];

describe("public API", () => {
  it("exports exactly the documented root API", () => {
    const sort = (names) => [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(sort(Object.keys(api)), sort(ROOT_EXPORTS));
  });

  it("keeps internals and the filesystem store out of the root", () => {
    for (const name of ["createFolderDocumentStore", "DOCUMENT_TYPES", "tokenize", "sqlIdentifier", "numericCell", "brandValidatedQuery", "withRetry"]) {
      assert.equal(name in api, false, name);
    }
  });

  it("the folder subpath exports only the store and its default types", async () => {
    const folder = await import("../../src/documents/FolderDocumentStore.js");
    assert.deepEqual(Object.keys(folder).sort(), ["DEFAULT_DOCUMENT_TYPES", "createFolderDocumentStore"]);
  });

  it("declares only the intended subpath exports", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./conversations/folder", "./documents/folder", "./documents/pdf", "./package.json", "./text-to-sql/postgres", "./ui/react", "./ui/react/styles.css"]);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines.node, ">=20.19.0");
  });

  it("loads from CommonJS consumers through require()", () => {
    const script = [
      'const root = require("@b2y/ai-service");',
      'const folder = require("@b2y/ai-service/documents/folder");',
      'const pg = require("@b2y/ai-service/text-to-sql/postgres");',
      'process.stdout.write(JSON.stringify([typeof root.createAiService, typeof root.defineTool, typeof folder.createFolderDocumentStore, typeof pg.createPostgresSqlValidator]));',
    ].join("\n");
    // Self-reference by package name resolves through package.json "exports" from inside the package.
    const out = execFileSync(process.execPath, ["-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ["function", "function", "function", "function"]);
  });
});
