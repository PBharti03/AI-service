import "./helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiServiceError, ANALYTICS_LIMITS, ANALYTICS_PLAN_TASK, ANALYTICS_PLAN_TASK_ID, buildResultChart, createAiService, createAnalyticsAssistant, createTaskRegistry, defineSqlPolicy, ErrorCodes, isValidatedQuery, mergeSections, observeSection } from "../src/index.js";
import { createPostgresSqlValidator } from "../src/sql/PostgresSqlValidator.js";
import { expectAiError, fail as failStep, FakeProvider, makeContext, reply } from "./helpers/Fixtures.js";

const context = makeContext({ permittedTasks: [ANALYTICS_PLAN_TASK_ID] });

/** Two unrelated tables, no joins or UNION, statistics only: the shape the planner exists for. */
function validator(overrides = {}) {
  return createPostgresSqlValidator(
    defineSqlPolicy({
      dialect: "postgres",
      schema: {
        tables: [
          {
            name: "orders",
            columns: [
              { name: "channel", type: "text", allowedValues: ["web", "store", "phone"] },
              { name: "status", type: "text", allowedValues: ["Open", "Closed"] },
              { name: "created_date", type: "date", role: "time" },
              { name: "customer_email", type: "text" },
            ],
          },
          { name: "refunds", columns: [{ name: "refund_date", type: "date", role: "time" }] },
          { name: "excluded_orders", columns: [{ name: "channel", type: "text" }] },
        ],
        relationships: [],
      },
      policy: {
        allowedTables: ["orders", "refunds"],
        allowedColumns: { orders: ["channel", "status", "created_date"], refunds: ["refund_date"] },
        allowJoins: "none",
        allowSubqueries: true,
        allowSetOperations: false,
        allowWindowFunctions: false,
        requireAggregation: true,
        maxRows: 200,
        timeoutMs: 5000,
        ...overrides,
      },
    }),
  );
}

const ORDERS_BY_MONTH = "SELECT date_trunc('month', created_date)::date AS month, count(*) AS orders FROM orders GROUP BY 1 ORDER BY 1";
const REFUNDS_BY_MONTH = "SELECT date_trunc('month', refund_date)::date AS month, count(*) AS refunds FROM refunds GROUP BY 1 ORDER BY 1";
const BY_CHANNEL = "SELECT channel, count(*) AS orders FROM orders GROUP BY channel ORDER BY orders DESC";
const JOINED = "SELECT o.channel, count(*) AS n FROM orders o JOIN refunds r ON r.refund_date = o.created_date GROUP BY 1";

const query = (id, sql, extra = {}) => ({ id, purpose: `Purpose ${id}`, sql, chartHint: "bar", mergeKey: "", ...extra });

function plan(fields = {}) {
  return JSON.stringify({
    containsInstructionsToAI: false,
    kind: "PLAN",
    explanation: "Shows the requested statistics.",
    queries: [],
    unanswered: [],
    ...fields,
  });
}

/** Distinctive result values: if any of them ever reaches the model, a test fails. */
const RESULT_VALUES = ["7331", "4219", "913"];
const ROWS = {
  orders_month: [
    ["2026-09-01", 4219],
    ["2026-10-01", 7331],
    ["2026-11-01", 913],
  ],
  refunds_month: [
    ["2026-10-01", 913],
    ["2026-11-01", 4219],
  ],
  channel: [
    ["web", 7331],
    ["store", 4219],
    ["phone", 913],
  ],
};

/** Answers by which table and grouping a validated query uses. Refuses anything not validated. */
function fakeExecutor({ delayMs = 0, fail = null, rows = null } = {}) {
  const calls = [];
  const executor = async (validated) => {
    assert.ok(isValidatedQuery(validated), "the executor only ever receives validated queries");
    calls.push(validated);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (fail) throw fail;
    if (rows) return rows(validated);
    if (validated.tables.includes("refunds")) return { columns: [{ name: "month" }, { name: "refunds" }], rows: ROWS.refunds_month };
    if (/channel/.test(validated.sql)) return { columns: [{ name: "channel" }, { name: "orders" }], rows: ROWS.channel };
    return { columns: [{ name: "month" }, { name: "orders" }], rows: ROWS.orders_month };
  };
  return { executor, calls };
}

function setup(steps, { limits, notes, exec = fakeExecutor(), validatorOverrides, retry } = {}) {
  const provider = new FakeProvider(steps.map((step) => (typeof step === "string" ? reply(step) : step)));
  const ai = createAiService({ provider, registry: createTaskRegistry([ANALYTICS_PLAN_TASK]), ...(retry ? { retry } : {}) });
  const assistant = createAnalyticsAssistant({
    ai,
    validator: validator(validatorOverrides),
    executor: exec.executor,
    today: () => "2026-11-04",
    catalog: {
      metrics: [{ name: "orders", description: "count(*) over orders" }],
      dimensions: [{ name: "channel", description: "orders.channel" }],
      limitations: ["refunds cannot be linked to orders"],
      labels: { orders: "Orders", refunds: "Refunds" },
      valueLabels: { web: "Web shop" },
    },
    ...(limits ? { limits } : {}),
    ...(notes ? { notes } : {}),
    describeExecutionError: (error) => error.code ?? "UNKNOWN",
  });
  return { provider, assistant, exec };
}

/** The task input the model received, decoded from the untrusted-data block. */
function sentInput(request) {
  const content = request?.messages[1]?.content ?? "";
  return JSON.parse(content.slice(content.indexOf("<untrusted_data>") + "<untrusted_data>".length, content.indexOf("</untrusted_data>")));
}

describe("analytics assistant: multi-query plans", () => {
  it("runs independent queries and lines them up on their merge key, in code", async () => {
    const { assistant, exec, provider } = setup([
      plan({
        queries: [
          query("q1", ORDERS_BY_MONTH, { chartHint: "line", mergeKey: "month" }),
          query("q2", REFUNDS_BY_MONTH, { chartHint: "line", mergeKey: "month" }),
        ],
      }),
    ]);
    const result = await assistant.answer({ question: "monthly orders and refunds", context });
    assert.equal(result.status, "ANSWERED");
    assert.equal(exec.calls.length, 2);
    assert.equal(result.sections.length, 1);
    const [section] = result.sections;
    assert.equal(section.id, "q1+q2");
    assert.deepEqual(section.queryIds, ["q1", "q2"]);
    assert.deepEqual(section.columns.map((column) => column.name), ["month", "orders", "refunds"]);
    assert.deepEqual(section.rows, [
      ["2026-09-01", 4219, null],
      ["2026-10-01", 7331, 913],
      ["2026-11-01", 913, 4219],
    ]);
    assert.equal(section.chart.chartType, "line");
    assert.deepEqual(section.chart.xLabels, ["Sep 2026", "Oct 2026", "Nov 2026"]);
    assert.deepEqual(section.chart.series.map((series) => series.name), ["Orders", "Refunds"]);
    assert.equal(section.chart.basis.fingerprints.length, 2);
    assert.equal(section.sql.length, 2);
    assert.deepEqual(result.queries.map((item) => item.id), ["q1", "q2"]);
    // The model was asked once and saw no result value.
    assert.equal(provider.requests.length, 1);
    const sent = JSON.stringify(provider.requests);
    for (const value of RESULT_VALUES) assert.ok(!sent.includes(value), `result value ${value} reached the model`);
  });

  it("gives evidence-backed observations and a summary built from them", async () => {
    const { assistant } = setup([plan({ queries: [query("q1", BY_CHANNEL)] })]);
    const result = await assistant.answer({ question: "orders by channel", context });
    const texts = result.sections[0].observations.map((observation) => observation.text);
    assert.ok(texts.includes("Orders: 12,463 in total across 3 groups."), texts.join(" | "));
    assert.ok(texts.includes("Web shop has the most orders: 7,331 (59% of 12,463)."), texts.join(" | "));
    assert.ok(texts.includes("phone has the fewest: 913."), texts.join(" | "));
    const top = result.sections[0].observations[1];
    assert.deepEqual(top.evidence, [{ queryIds: ["q1"], label: "web", column: "orders", value: 7331 }]);
    assert.ok(result.summary.startsWith("Shows the requested statistics. Orders: 12,463"));
  });

  it("follow-ups send only earlier questions and SQL, re-validated, never results", async () => {
    const { assistant, provider } = setup([plan({ queries: [query("q1", BY_CHANNEL)] }), plan({ queries: [query("q1", ORDERS_BY_MONTH)] })]);
    const first = await assistant.answer({ question: "orders by channel", context });
    const conversation = [{ question: "orders by channel", queries: first.queries.map((item) => item.sql) }];
    const second = await assistant.answer({ question: "and per month?", context, conversation });
    assert.equal(second.status, "ANSWERED");
    const input = sentInput(provider.requests[1]);
    assert.deepEqual(input.conversation, [{ question: "orders by channel", queries: [BY_CHANNEL] }]);
    const sent = JSON.stringify(provider.requests);
    for (const value of RESULT_VALUES) assert.ok(!sent.includes(value), `result value ${value} reached the model`);
  });

  it("refuses a conversation whose earlier SQL was tampered with, before asking the model", async () => {
    const { assistant, provider } = setup([]);
    const result = await assistant.answer({
      question: "and per month?",
      context,
      conversation: [{ question: "orders", queries: ["SELECT customer_email FROM orders"] }],
    });
    assert.equal(result.status, "REJECTED");
    assert.equal(result.code, "CONVERSATION_INVALID");
    assert.equal(provider.requests.length, 0);
  });

  it("passes NOT_ANALYTICS and WRITE_REQUEST through without running anything", async () => {
    const exec = fakeExecutor();
    const { assistant } = setup(
      [
        JSON.stringify({ containsInstructionsToAI: false, kind: "NOT_ANALYTICS", explanation: "A greeting.", queries: [], unanswered: [] }),
        JSON.stringify({ containsInstructionsToAI: false, kind: "WRITE_REQUEST", explanation: "Asks to delete.", queries: [], unanswered: [] }),
      ],
      { exec },
    );
    assert.equal((await assistant.answer({ question: "hello", context })).status, "NOT_ANALYTICS");
    assert.equal((await assistant.answer({ question: "delete web orders", context })).status, "WRITE_REQUEST");
    assert.equal(exec.calls.length, 0);
  });
});

describe("analytics assistant: invalid plans and partial failures", () => {
  it("repairs a rejected query once, sending only its SQL, code and reason", async () => {
    const { assistant, provider } = setup([
      plan({ queries: [query("q1", BY_CHANNEL), query("q2", JOINED)] }),
      plan({ queries: [query("q1", BY_CHANNEL), query("q2", REFUNDS_BY_MONTH)] }),
    ]);
    const result = await assistant.answer({ question: "orders by channel and refunds", context });
    assert.equal(result.status, "ANSWERED");
    assert.equal(result.repairAttempts, 1);
    assert.deepEqual(sentInput(provider.requests[1]).repair, [
      { id: "q2", previousSql: JOINED, code: "SQL_JOIN_NOT_ALLOWED", reason: "Joins are not allowed" },
    ]);
    assert.equal(result.sections.length, 2);
  });

  it("answers the valid parts and explains the part that stayed invalid", async () => {
    const { assistant, exec } = setup([
      plan({ queries: [query("q1", BY_CHANNEL), query("q2", JOINED)] }),
      plan({ queries: [query("q1", BY_CHANNEL), query("q2", JOINED)] }),
    ]);
    const result = await assistant.answer({ question: "orders by channel and refunds by channel", context });
    assert.equal(result.status, "PARTIAL");
    assert.equal(exec.calls.length, 1);
    assert.equal(result.sections.length, 1);
    assert.deepEqual(result.failures, [
      { queryId: "q2", title: "Purpose q2", code: "SQL_JOIN_NOT_ALLOWED", reason: "It would need to combine tables, which the safety rules do not allow." },
    ]);
    assert.match(result.summary, /1 part of the question could not be answered/);
  });

  it("reports parts the plan marks unanswered, and FAILED when nothing could run", async () => {
    const { assistant } = setup([plan({ unanswered: [{ part: "refunds by channel", reason: "refunds cannot be linked to orders" }] })]);
    const result = await assistant.answer({ question: "refunds by channel", context });
    assert.equal(result.status, "FAILED");
    assert.deepEqual(result.unanswered, [{ part: "refunds by channel", reason: "refunds cannot be linked to orders" }]);
    assert.match(result.summary, /No part of the question could be answered/);
  });

  it("refuses plans with more than four queries or duplicate ids (model output is never trusted)", async () => {
    const five = ["q1", "q2", "q3", "q4", "q4"].map((id) => query(id, BY_CHANNEL));
    const { assistant } = setup([plan({ queries: five }), plan({ queries: [query("q1", BY_CHANNEL), query("q1", ORDERS_BY_MONTH)] })]);
    await expectAiError(() => assistant.answer({ question: "everything", context }), ErrorCodes.OUTPUT_SCHEMA_INVALID);
    await expectAiError(() => assistant.answer({ question: "everything", context }), ErrorCodes.OUTPUT_REJECTED);
  });

  it("does not run queries beyond the application's query limit", async () => {
    const { assistant, exec, provider } = setup([plan({ queries: [query("q1", BY_CHANNEL), query("q2", ORDERS_BY_MONTH), query("q3", REFUNDS_BY_MONTH)] })], {
      limits: { maxQueries: 2 },
    });
    const result = await assistant.answer({ question: "three things", context });
    assert.equal(sentInput(provider.requests[0]).maxQueries, 2);
    assert.equal(exec.calls.length, 2);
    assert.deepEqual(result.failures.map((failure) => [failure.queryId, failure.code]), [["q3", "QUERY_LIMIT"]]);
  });

  it("stops at the combined row limit", async () => {
    const rows = () => ({ columns: [{ name: "day" }, { name: "n" }], rows: Array.from({ length: 150 }, (_, index) => [`2026-01-${String((index % 28) + 1).padStart(2, "0")}`, index]) });
    const { assistant, exec } = setup([plan({ queries: [query("q1", BY_CHANNEL), query("q2", ORDERS_BY_MONTH), query("q3", REFUNDS_BY_MONTH)] })], {
      limits: { maxTotalRows: 300 },
      exec: fakeExecutor({ rows }),
    });
    const result = await assistant.answer({ question: "a lot", context });
    assert.equal(exec.calls.length, 3);
    assert.equal(result.totalRows, 300);
    assert.deepEqual(result.failures.map((failure) => [failure.queryId, failure.code]), [["q3", "ROW_LIMIT"]]);
  });

  it("stops at the time limit while executing and reports the parts that did not run", async () => {
    const { assistant } = setup([plan({ queries: [query("q1", BY_CHANNEL), query("q2", ORDERS_BY_MONTH)] })], {
      limits: { timeoutMs: 150 },
      exec: fakeExecutor({ delayMs: 400 }),
    });
    const started = Date.now();
    const result = await assistant.answer({ question: "slow", context });
    assert.ok(Date.now() - started < 400, "returned at the deadline, not after the slow query");
    assert.equal(result.status, "FAILED");
    assert.deepEqual(result.failures.map((failure) => [failure.queryId, failure.code]), [["q1", "TIME_LIMIT"], ["q2", "TIME_LIMIT"]]);
  });

  it("stops at the time limit while planning", async () => {
    const { assistant } = setup([{ kind: "hang" }], { limits: { timeoutMs: 120 } });
    const result = await assistant.answer({ question: "slow model", context });
    assert.equal(result.status, "FAILED");
    assert.equal(result.failures[0].code, "TIME_LIMIT");
  });

  it("reports an execution failure with a short code only", async () => {
    const error = Object.assign(new Error("relation secret_table does not exist"), { code: "42P01" });
    const { assistant } = setup([plan({ queries: [query("q1", BY_CHANNEL)] })], { exec: fakeExecutor({ fail: error }) });
    const result = await assistant.answer({ question: "orders", context });
    assert.deepEqual(result.failures, [
      { queryId: "q1", title: "Purpose q1", code: "EXECUTION_FAILED", reason: "The database could not run the query for this part.", detail: "42P01" },
    ]);
    assert.ok(!JSON.stringify(result).includes("secret_table"));
  });

  it("refuses limits above the package maximums", () => {
    for (const limits of [{ maxQueries: 5 }, { maxTotalRows: 601 }, { timeoutMs: 15_001 }, { maxQueries: 0 }]) {
      assert.throws(() => setup([], { limits }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    }
    assert.deepEqual(ANALYTICS_LIMITS, { maxQueries: 4, maxTotalRows: 600, timeoutMs: 15_000 });
  });
});

describe("analytics assistant: provider rate limits (HTTP 429)", () => {
  const rateLimited = (details = { status: 429 }) =>
    failStep(new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "Provider rate limit reached (HTTP 429)", { retryable: true, details }));
  // A short Retry-After (0 s here, so the test does not sleep): the one bounded rate-limit retry applies.
  const brieflyLimited = () => rateLimited({ status: 429, retryAfterSeconds: 0 });

  it("a rate-limited plan runs nothing on the database", async () => {
    const { assistant, exec } = setup([rateLimited()]);
    await expectAiError(() => assistant.answer({ question: "orders by channel", context }), ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(exec.calls.length, 0);
  });

  it("a rate-limited repair runs nothing either: every model call finishes before any query executes", async () => {
    const { assistant, exec } = setup([plan({ queries: [query("q1", BY_CHANNEL), query("q2", JOINED)] }), rateLimited()]);
    await expectAiError(() => assistant.answer({ question: "orders and refunds", context }), ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(exec.calls.length, 0);
  });

  it("the bounded rate-limit retry repeats only the model call; each query still runs exactly once", async () => {
    const { assistant, exec, provider } = setup([brieflyLimited(), plan({ queries: [query("q1", ORDERS_BY_MONTH, { mergeKey: "month" }), query("q2", REFUNDS_BY_MONTH, { mergeKey: "month" })] })]);
    const result = await assistant.answer({ question: "monthly orders and refunds", context });
    assert.equal(result.status, "ANSWERED");
    assert.equal(provider.requests.length, 2);
    assert.equal(exec.calls.length, 2);
    assert.equal(new Set(exec.calls.map((call) => call.fingerprint)).size, 2);
  });

  it("gives up after the one rate-limit retry, even with general retries enabled", async () => {
    const { assistant, exec, provider } = setup([brieflyLimited(), brieflyLimited(), brieflyLimited()], { retry: { maxRetries: 3, baseDelayMs: 0 } });
    await expectAiError(() => assistant.answer({ question: "orders", context }), ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(provider.requests.length, 2);
    assert.equal(exec.calls.length, 0);
  });
});

describe("analytics assistant: application notes", () => {
  const excludedValidator = createPostgresSqlValidator(
    defineSqlPolicy({
      dialect: "postgres",
      schema: { tables: [{ name: "excluded_orders", columns: [{ name: "channel", type: "text" }] }], relationships: [] },
      policy: { allowedTables: ["excluded_orders"], allowedColumns: { excluded_orders: ["channel"] }, requireAggregation: true, maxRows: 10, timeoutMs: 5000 },
    }),
  );
  const notes = [
    { id: "refunds-unlinked", appliesTo: ({ queries }) => queries.some((item) => item.tables.includes("refunds")), text: "Refunds cannot be linked to orders." },
    {
      id: "excluded",
      appliesTo: ({ question }) => /channel/.test(question),
      queries: ["SELECT count(*) AS excluded FROM excluded_orders"],
      validator: excludedValidator,
      render: ([result]) => `${String(result.rows[0][0])} test orders are excluded.`,
    },
    { id: "never", appliesTo: () => false, text: "Never shown." },
  ];

  it("adds notes chosen from the validated plan, with values computed in code", async () => {
    const exec = fakeExecutor({
      rows: (validated) =>
        validated.tables.includes("excluded_orders")
          ? { columns: [{ name: "excluded" }], rows: [[5]] }
          : { columns: [{ name: "month" }, { name: "refunds" }], rows: ROWS.refunds_month },
    });
    const { assistant } = setup([plan({ queries: [query("q1", REFUNDS_BY_MONTH)] })], { notes, exec });
    const result = await assistant.answer({ question: "refunds per month by channel", context });
    assert.deepEqual(result.notes, [
      { id: "refunds-unlinked", text: "Refunds cannot be linked to orders." },
      { id: "excluded", text: "5 test orders are excluded." },
    ]);
  });

  it("skips a note whose query fails validation", async () => {
    const broken = [{ id: "broken", appliesTo: () => true, queries: ["SELECT channel FROM excluded_orders"], validator: excludedValidator, render: () => "x" }];
    const { assistant } = setup([plan({ queries: [query("q1", BY_CHANNEL)] })], { notes: broken });
    assert.deepEqual((await assistant.answer({ question: "orders by channel", context })).notes, []);
  });
});

describe("result merging and observations", () => {
  const section = (id, columns, rows, mergeKey = "") => ({ id, title: id, queryIds: [id], columns: columns.map((name) => ({ name })), rows, truncated: false, mergeKey });

  it("keeps results separate when they do not share a usable key", () => {
    const out = mergeSections([
      section("q1", ["month", "orders"], ROWS.orders_month, "month"),
      section("q2", ["channel", "orders"], ROWS.channel, "month"),
      section("q3", ["month", "refunds"], ROWS.refunds_month, ""),
    ]);
    assert.deepEqual(out.map((item) => item.id), ["q1", "q2", "q3"]);
    assert.ok(out.every((item) => !("mergeKey" in item)));
  });

  it("renames clashing metric columns when merging", () => {
    const [merged] = mergeSections([section("q1", ["month", "n"], ROWS.orders_month, "month"), section("q2", ["month", "n"], ROWS.refunds_month, "month")]);
    assert.deepEqual(merged.columns.map((column) => column.name), ["month", "n", "n_q2"]);
  });

  it("describes a time series: total, peak, latest change, gaps and an unfinished period", () => {
    const [merged] = mergeSections([section("q1", ["month", "orders"], ROWS.orders_month, "month"), section("q2", ["month", "refunds"], ROWS.refunds_month, "month")]);
    const texts = observeSection(merged, { today: "2026-11-04", labels: { orders: "Orders", refunds: "Refunds" } }).map((item) => item.text);
    assert.deepEqual(texts, [
      "Orders: 12,463 in total from Sep 2026 to Nov 2026.",
      "Orders peaked in Oct 2026 (7,331).",
      "Orders: 913 in Nov 2026 compared with 7,331 in Oct 2026 (-88%); Nov 2026 is not over yet.",
      "Refunds: 5,132 in total from Oct 2026 to Nov 2026.",
      "Refunds peaked in Nov 2026 (4,219).",
      "Refunds: 4,219 in Nov 2026 compared with 913 in Oct 2026 (+362%); Nov 2026 is not over yet.",
      "No refunds recorded in Sep 2026.",
    ]);
  });

  it("names a single period once", () => {
    const texts = observeSection(section("q1", ["month", "orders"], [["2026-11-01", 2]])).map((item) => item.text);
    assert.equal(texts[0], "Orders: 2 in total in Nov 2026.");
  });

  it("flags small totals and empty results", () => {
    const small = observeSection(section("q1", ["channel", "orders"], [["web", 3], ["store", 2]]));
    assert.ok(small.some((item) => item.text === "These are small numbers (5 in total), so shares and changes can swing a lot."));
    assert.deepEqual(observeSection(section("q1", ["channel", "orders"], [])), [{ text: "q1: no matching data.", evidence: [] }]);
  });

  it("charts carry the fingerprints of every statement they show", () => {
    const fingerprint = "a".repeat(64);
    const chart = buildResultChart({ columns: [{ name: "channel" }, { name: "orders" }], rows: ROWS.channel }, { fingerprints: [fingerprint], title: "Orders" });
    assert.deepEqual(chart.basis.fingerprints, [fingerprint]);
    assert.equal(chart.title, "Orders");
  });
});
