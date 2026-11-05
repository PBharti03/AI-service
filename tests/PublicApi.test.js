import assert from "node:assert/strict";
import * as api from "../src/index.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Pins the public API: adding or removing a root export must be a deliberate change to this list.

const ROOT_EXPORTS = [
  "AI_BUSY_MESSAGE",
  "AiServiceError",
  "aiUserMessage",
  "ANALYTICS_LIMITS",
  "ANALYTICS_PLAN_TASK",
  "ANALYTICS_PLAN_TASK_ID",
  "analyticsReportToBlocks",
  "APP_DATA_MAX_BYTES",
  "APPROVED_PAID_HOSTS",
  "assertAuthorized",
  "ASSISTANT_RESPOND_TASK",
  "ASSISTANT_RESPOND_TASK_ID",
  "ASSISTANT_ROUTE_TASK",
  "ASSISTANT_ROUTE_TASK_ID",
  "buildResultChart",
  "buildSchemaContext",
  "buildSearchIndex",
  "CAPABILITY_KINDS",
  "CHART_HINTS",
  "CHART_TYPES",
  "chartSpecSchema",
  "checkQueryResult",
  "createAiAssistant",
  "createAiService",
  "createAnalyticsAssistant",
  "createAnalyticsCapability",
  "createConversationHistory",
  "createDocumentQaAgent",
  "createDocumentsCapability",
  "createGroqProvider",
  "createIndexDocumentSource",
  "createMemoryConversationStore",
  "createOpenAICompatibleProvider",
  "createProvider",
  "createTaskRegistry",
  "DATA_CLASSIFICATIONS",
  "DEFAULT_MAX_REQUEST_BYTES",
  "DEFAULT_MAX_RESPONSE_BYTES",
  "DEFAULT_RETENTION_DAYS",
  "defineAnalyticsCatalog",
  "defineApplicationProfile",
  "defineCapability",
  "defineConversationStore",
  "defineDocumentSource",
  "defineSqlPolicy",
  "defineTask",
  "describePolicyRules",
  "DOCUMENT_ANSWER_TASK",
  "DOCUMENT_ANSWER_TASK_ID",
  "ErrorCategories",
  "errorCategory",
  "ErrorCodes",
  "GROQ_BASE_URL",
  "GROQ_DEFAULT_MODEL",
  "hasFeature",
  "hasPermission",
  "isAnalyticsCatalog",
  "isApplicationProfile",
  "isCapability",
  "isConversationStore",
  "isDocumentSource",
  "isRateLimited",
  "isSqlPolicy",
  "isValidatedQuery",
  "MAX_PASSAGE_CHARS",
  "MAX_PLAN_CONVERSATION_TURNS",
  "MAX_PLAN_QUERIES",
  "MAX_RETENTION_DAYS",
  "mergeSections",
  "noopLogger",
  "observeSection",
  "parseTrustedContext",
  "PROVIDER_TYPES",
  "rateLimitInfo",
  "responseBlocksSchema",
  "scheduleConversationCleanup",
  "searchIndex",
  "splitIntoPassages",
  "SQL_AGGREGATE_FUNCTIONS",
  "SQL_COLUMN_TYPES",
  "SQL_DIALECTS",
  "SQL_SAFE_FUNCTIONS",
  "SQL_SAFE_WINDOW_FUNCTIONS",
  "SqlValidationCodes",
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
    const folder = await import("../src/documents/FolderDocumentStore.js");
    assert.deepEqual(Object.keys(folder).sort(), ["DEFAULT_DOCUMENT_TYPES", "createFolderDocumentStore"]);
  });

  it("declares only the intended subpath exports", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./conversations/folder", "./documents/folder", "./documents/pdf", "./package.json", "./text-to-sql/postgres", "./ui/react", "./ui/react/styles.css"]);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines.node, ">=20.19.0");
  });

  it("loads from CommonJS consumers through require()", () => {
    const script = [
      'const root = require("@b2y/ai-service");',
      'const folder = require("@b2y/ai-service/documents/folder");',
      'const pg = require("@b2y/ai-service/text-to-sql/postgres");',
      'process.stdout.write(JSON.stringify([typeof root.createAiService, typeof root.createAiAssistant, typeof folder.createFolderDocumentStore, typeof pg.createPostgresSqlValidator]));',
    ].join("\n");
    // Self-reference by package name resolves through package.json "exports" from inside the package.
    const out = execFileSync(process.execPath, ["-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ["function", "function", "function", "function"]);
  });
});
