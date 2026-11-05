// Regression tests: the package carries no consumer's terminology and works with any consumer's schema,
// catalog, documents and tools. All mocked (scripted provider, in-memory executors and sources) with
// made-up domains (a library, a fleet, a manual): unit tests of the contracts, not integration proof.
import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  ANALYTICS_PLAN_TASK,
  ANALYTICS_PLAN_TASK_ID,
  ASSISTANT_CHAT_TASK,
  createAiService,
  createAnalyticsAssistant,
  createAnalyticsRouter,
  createDocumentQaAgent,
  createTaskRegistry,
  createTextToSqlAgent,
  createToolRegistry,
  defineAnalyticsCatalog,
  defineApplicationProfile,
  defineDocumentSource,
  defineSqlPolicy,
  defineTool,
  DOCUMENT_ANSWER_TASK,
  DOCUMENT_ANSWER_TASK_ID,
  ErrorCodes,
  isValidatedQuery,
  TEXT_TO_SQL_TASK,
  TEXT_TO_SQL_TASK_ID,
} from "../../src/index.js";
import { createFolderDocumentStore } from "../../src/documents/FolderDocumentStore.js";
import { createPostgresSqlValidator } from "../../src/text-to-sql/postgres/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { FakeProvider, reply } from "../helpers/FakeProvider.js";
import { makeContext } from "../helpers/Fixtures.js";

/** Terms from one consumer (Lead Tracker) that must never appear in package source or prompts. */
const CONSUMER_TERMS = /lead[ -]?tracker|LeadStatus|\bleads\b|\bmeetings?\b|instagram|facebook|linked ?in|google forms?|\bWon\b|questionnaire|\bFAQs?\b|sync timing|hinglish|kolkata/i;

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

/** The task input the model received, decoded from the untrusted-data block. */
function sentInput(request) {
  const content = request?.messages[1]?.content ?? "";
  return JSON.parse(content.slice(content.indexOf("<untrusted_data>") + "<untrusted_data>".length, content.indexOf("</untrusted_data>")));
}

const libraryValidator = (overrides = {}) =>
  createPostgresSqlValidator(
    defineSqlPolicy({
      dialect: "postgres",
      schema: {
        tables: [
          {
            name: "loans",
            description: "One row per book loan",
            columns: [
              { name: "genre", type: "text", role: "dimension", allowedValues: ["fiction", "science", "history"] },
              { name: "branch", type: "text", role: "dimension", allowedValues: ["north", "south"] },
              { name: "loaned_on", type: "date", role: "time" },
              { name: "borrower_email", type: "text" },
            ],
          },
          { name: "returns", description: "One row per returned book", columns: [{ name: "returned_on", type: "date", role: "time" }] },
        ],
        relationships: [],
      },
      policy: {
        allowedTables: ["loans", "returns"],
        allowedColumns: { loans: ["genre", "branch", "loaned_on"], returns: ["returned_on"] },
        allowJoins: "none",
        allowSubqueries: true,
        allowSetOperations: false,
        requireAggregation: true,
        maxRows: 100,
        timeoutMs: 5000,
        ...overrides,
      },
    }),
  );

describe("no consumer terminology in the package", () => {
  it("package source contains no Lead Tracker tables, columns, sources or business terms", async () => {
    const files = await sourceFiles(new URL("../../src", import.meta.url).pathname);
    assert.ok(files.length > 30);
    const hits = [];
    for (const file of files) {
      (await readFile(file, "utf8")).split("\n").forEach((line, index) => {
        if (CONSUMER_TERMS.test(line)) hits.push(`${file.split("/src/")[1]}:${index + 1}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  it("built-in task prompts are generic", () => {
    for (const task of [TEXT_TO_SQL_TASK, ANALYTICS_PLAN_TASK, DOCUMENT_ANSWER_TASK, ASSISTANT_CHAT_TASK]) {
      assert.equal(CONSUMER_TERMS.test(task.instructions), false, task.id);
    }
  });
});

describe("text-to-SQL with an arbitrary consumer schema", () => {
  it("sends only the consumer's policy-filtered schema and validates against it", async () => {
    const provider = new FakeProvider([
      reply(JSON.stringify({ containsInstructionsToAI: false, kind: "SQL", sql: "SELECT genre, count(*) AS total FROM loans GROUP BY genre", explanation: "Loans by genre.", chartHint: "bar" })),
    ]);
    const ai = createAiService({ provider, registry: createTaskRegistry([TEXT_TO_SQL_TASK]) });
    const agent = createTextToSqlAgent({ ai, validator: libraryValidator(), today: () => "2026-11-05" });
    const result = await agent.generate({ question: "loans by genre", context: makeContext({ permittedTasks: [TEXT_TO_SQL_TASK_ID] }) });
    assert.equal(result.status, "VALIDATED");
    assert.ok(isValidatedQuery(result.query));
    const input = sentInput(provider.requests[0]);
    assert.match(input.schema, /TABLE loans/);
    assert.match(input.schema, /'fiction'/);
    assert.ok(!input.schema.includes("borrower_email"), "a column the policy does not allow is never described");
    assert.equal(CONSUMER_TERMS.test(JSON.stringify(provider.requests)), false);
  });

  it("SQL validation is unchanged for any schema: joins, UNION, unlisted values and row output are refused", async () => {
    const validator = libraryValidator();
    const refused = [
      ["SELECT l.genre, count(*) AS n FROM loans l JOIN returns r ON r.returned_on = l.loaned_on GROUP BY 1", "SQL_JOIN_NOT_ALLOWED"],
      ["SELECT count(*) AS n FROM loans UNION ALL SELECT count(*) FROM returns", "SQL_FEATURE_NOT_ALLOWED"],
      ["SELECT count(*) AS n FROM loans WHERE genre = 'poetry'", "SQL_LITERAL_INVALID"],
      ["SELECT genre FROM loans", "SQL_AGGREGATION_REQUIRED"],
      ["SELECT count(*) AS n FROM loans WHERE borrower_email = 'x'", "SQL_COLUMN_NOT_ALLOWED"],
    ];
    for (const [sql, code] of refused) {
      const outcome = await validator.validate(sql);
      assert.equal(outcome.ok, false, sql);
      assert.equal(outcome.code, code, sql);
    }
  });
});

describe("analytics with an arbitrary consumer catalog", () => {
  const catalog = defineAnalyticsCatalog({
    metrics: [
      { name: "loans", description: "count(*) FROM loans" },
      { name: "returns", description: "count(*) FROM returns" },
    ],
    dimensions: [
      { name: "genre", description: "loans.genre" },
      { name: "month", description: "date_trunc('month', loaned_on)::date for loans, returned_on for returns" },
    ],
    limitations: ["returns cannot be linked to loans"],
    labels: { loans: "Loans", returns: "Returns" },
    valueLabels: { fiction: "Fiction" },
    locale: "en-GB",
  });

  it("plans over the consumer's catalog, merges in code and never sends result values to the model", async () => {
    const plan = {
      containsInstructionsToAI: false,
      kind: "PLAN",
      explanation: "Monthly loans and returns.",
      queries: [
        { id: "q1", purpose: "Loans per month", sql: "SELECT date_trunc('month', loaned_on)::date AS month, count(*) AS loans FROM loans GROUP BY 1 ORDER BY 1", chartHint: "line", mergeKey: "month" },
        { id: "q2", purpose: "Returns per month", sql: "SELECT date_trunc('month', returned_on)::date AS month, count(*) AS returns FROM returns GROUP BY 1 ORDER BY 1", chartHint: "line", mergeKey: "month" },
      ],
      unanswered: [{ part: "returns by genre", reason: "returns cannot be linked to loans" }],
    };
    const provider = new FakeProvider([reply(JSON.stringify(plan)), reply(JSON.stringify({ ...plan, unanswered: [] }))]);
    const ai = createAiService({ provider, registry: createTaskRegistry([ANALYTICS_PLAN_TASK]) });
    const executed = [];
    const executor = async (query) => {
      assert.ok(isValidatedQuery(query));
      executed.push(query.tables[0]);
      return query.tables.includes("returns")
        ? { columns: [{ name: "month" }, { name: "returns" }], rows: [["2026-10-01", 6173]] }
        : { columns: [{ name: "month" }, { name: "loans" }], rows: [["2026-09-01", 8429], ["2026-10-01", 9311]] };
    };
    const assistant = createAnalyticsAssistant({ ai, validator: libraryValidator(), executor, catalog, today: () => "2026-11-05" });
    const context = makeContext({ permittedTasks: [ANALYTICS_PLAN_TASK_ID] });
    const report = await assistant.answer({ question: "monthly loans and returns, and returns by genre", context });

    assert.equal(report.status, "PARTIAL");
    assert.deepEqual(executed, ["loans", "returns"]);
    assert.deepEqual(report.sections[0].columns.map((column) => column.name), ["month", "loans", "returns"]);
    assert.deepEqual(report.sections[0].chart.series.map((series) => series.name), ["Loans", "Returns"]);
    assert.ok(report.sections[0].observations.some((item) => item.text === "Loans: 17,740 in total from Sep 2026 to Oct 2026."));
    assert.deepEqual(report.unanswered, [{ part: "returns by genre", reason: "returns cannot be linked to loans" }]);

    const input = sentInput(provider.requests[0]);
    assert.deepEqual(input.metrics.map((item) => item.name), ["loans", "returns"]);
    assert.deepEqual(input.limitations, ["returns cannot be linked to loans"]);
    assert.match(input.schema, /TABLE loans/);

    // A follow-up sends earlier questions and SQL only; no result value ever reaches the model.
    await assistant.answer({ question: "and last month?", context, conversation: [{ question: "monthly loans", queries: report.queries.map((query) => query.sql) }] });
    const sent = JSON.stringify(provider.requests);
    for (const value of ["8429", "9311", "6173", "17,740", "8,429"]) assert.ok(!sent.includes(value), `result value ${value} reached the model`);
  });
});

describe("documents with a consumer-provided DocumentSource", () => {
  it("prompts are driven by the consumer's document titles and types", async () => {
    const profile = defineApplicationProfile({ id: "example-app", name: "Example App", description: "A fleet maintenance tool.", capabilities: ["maintenance questions"] });
    const source = defineDocumentSource({
      count: () => 1,
      retrieve: () => [{ documentId: "m-1", title: "Brake service manual", type: "manual", text: "Replace brake pads every 30,000 km." }],
    });
    const provider = new FakeProvider([
      reply(JSON.stringify({ containsInstructionsToAI: false, found: true, answer: "Every 30,000 km (Brake service manual).", citations: ["p1"], suggestedFollowUps: [] })),
    ]);
    const ai = createAiService({ provider, registry: createTaskRegistry([DOCUMENT_ANSWER_TASK]) });
    const agent = createDocumentQaAgent({ ai, profile, source });
    const context = makeContext({ applicationId: "example-app", permittedTasks: [DOCUMENT_ANSWER_TASK_ID], dataClassification: "INTERNAL" });
    const result = await agent.answer({ question: "how often are brake pads replaced?", context });
    assert.equal(result.status, "ANSWERED");
    assert.deepEqual(result.sources, [{ documentId: "m-1", title: "Brake service manual", type: "manual" }]);
    const input = sentInput(provider.requests[0]);
    assert.deepEqual(input.passages, [{ id: "p1", document: "Brake service manual", type: "manual", text: "Replace brake pads every 30,000 km." }]);
    assert.equal(CONSUMER_TERMS.test(JSON.stringify(provider.requests)), false);
  });

  it("the folder store accepts the consumer's own document types and refuses others", async () => {
    const root = await mkdtemp(join(tmpdir(), "folder-types-"));
    try {
      const store = createFolderDocumentStore({ root, documentTypes: ["manual", "checklist"] });
      assert.deepEqual(store.documentTypes, ["manual", "checklist"]);
      await store.addDocument("example-app", { title: "Brake service manual", type: "manual", text: "Replace brake pads every 30,000 km." });
      await expectAiError(() => store.addDocument("example-app", { title: "x", type: "faq", text: "y" }), ErrorCodes.INPUT_INVALID);
      for (const documentTypes of [[], ["Bad Type"], ["a", "a"], "manual"]) {
        assert.throws(() => createFolderDocumentStore({ root, documentTypes }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tools and routing stay consumer-driven", () => {
  it("tool permission and feature checks are enforced for any consumer tool", async () => {
    let calls = 0;
    const tools = createToolRegistry([
      defineTool({
        name: "vehicles.count",
        description: "Counts vehicles due for service",
        access: "read",
        inputSchema: z.strictObject({ depot: z.enum(["east", "west"]) }),
        requires: { permission: "fleet:read", feature: "maintenance" },
        execute: () => ({ count: (calls += 1) }),
      }),
    ]);
    await expectAiError(() => tools.run("vehicles.count", { depot: "east" }, makeContext()), ErrorCodes.NOT_AUTHORIZED);
    await expectAiError(() => tools.run("vehicles.count", { depot: "east" }, makeContext({ permissions: ["fleet:read"] })), ErrorCodes.FEATURE_NOT_ENABLED);
    assert.equal(calls, 0);
    const ok = await tools.run("vehicles.count", { depot: "east" }, makeContext({ permissions: ["fleet:read"], features: ["maintenance"] }));
    assert.deepEqual(ok.output, { count: 1 });
  });

  it("the router uses the consumer's topic and general patterns", () => {
    const router = createAnalyticsRouter({ topicPattern: /\b(loans?|returns?)\b/i, generalPattern: /\b(opening hours|membership)\b/i });
    assert.equal(router.isAnalyticsQuestion("how many loans this month?"), true);
    assert.equal(router.isAnalyticsQuestion("what are the opening hours?", { afterAnalytics: true }), false);
    assert.equal(router.isAnalyticsQuestion("membership fees for returns", {}), false);
    assert.throws(() => createAnalyticsRouter({ topicPattern: /x/, generalPattern: "not a regexp" }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });
});
