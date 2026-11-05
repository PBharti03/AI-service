// Unit tests for the package's contracts and factories. Everything here is mocked (scripted provider,
// stub fetch, in-memory tools and document sources): these tests prove contract behaviour, not any
// application's data or integration.
import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  AiServiceError,
  assertAuthorized,
  createAiService,
  createAnalyticsAssistant,
  createDocumentQaAgent,
  createGroqProvider,
  createIndexDocumentSource,
  createProvider,
  createTaskRegistry,
  createToolRegistry,
  defineAnalyticsCatalog,
  defineApplicationProfile,
  defineDocumentSource,
  defineTool,
  DOCUMENT_ANSWER_TASK,
  DOCUMENT_ANSWER_TASK_ID,
  ANALYTICS_PLAN_TASK,
  ANALYTICS_PLAN_TASK_ID,
  ASSISTANT_RESPOND_TASK,
  ASSISTANT_RESPOND_TASK_ID,
  ErrorCategories,
  errorCategory,
  ErrorCodes,
  GROQ_BASE_URL,
  hasFeature,
  hasPermission,
  isAnalyticsCatalog,
  parseTrustedContext,
  buildSearchIndex,
} from "../../src/index.js";
import { createPostgresSqlValidator } from "../../src/text-to-sql/postgres/index.js";
import { defineSqlPolicy } from "../../src/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { FakeProvider, reply } from "../helpers/FakeProvider.js";
import { completionBody, jsonResponse, stubFetch } from "../helpers/FetchStubs.js";
import { makeContext } from "../helpers/Fixtures.js";

const SECRET_INPUT = "PLANTED-INPUT-VALUE-91c2";

describe("application context contract", () => {
  it("accepts consumer-supplied permissions and features, de-duplicated and frozen", () => {
    const context = parseTrustedContext(makeContext({ permissions: ["reports:read", "reports:read"], features: ["analytics"] }));
    assert.deepEqual(context.permissions, ["reports:read"]);
    assert.deepEqual(context.features, ["analytics"]);
    assert.ok(Object.isFrozen(context.permissions) && Object.isFrozen(context.features));
  });

  it("still rejects unknown fields, and invalid permission names", () => {
    for (const extra of [{ role: "admin" }, { permissions: ["Has Spaces"] }, { features: [""] }, { subscription: "gold" }]) {
      assert.throws(() => parseTrustedContext(makeContext(extra)), (error) => error.code === ErrorCodes.CONTEXT_INVALID);
    }
  });

  it("grants nothing that the consumer did not list", () => {
    const context = makeContext();
    assert.equal(hasPermission(context, "reports:read"), false);
    assert.equal(hasFeature(context, "analytics"), false);
    assert.throws(() => assertAuthorized(context, { permission: "reports:read" }), (error) => error.code === ErrorCodes.NOT_AUTHORIZED);
    assert.throws(() => assertAuthorized(context, { feature: "analytics" }), (error) => error.code === ErrorCodes.FEATURE_NOT_ENABLED);
  });

  it("passes when the consumer granted the requirement, and returns the frozen context", () => {
    const parsed = assertAuthorized(makeContext({ permissions: ["reports:read"], features: ["analytics"] }), { permission: "reports:read", feature: "analytics" });
    assert.ok(Object.isFrozen(parsed));
  });
});

describe("typed errors", () => {
  it("every error code has a category", () => {
    for (const code of Object.values(ErrorCodes)) assert.ok(Object.hasOwn(ErrorCategories, code), code);
    assert.equal(Object.keys(ErrorCategories).length, Object.keys(ErrorCodes).length);
  });

  it("categorises errors, and anything foreign as internal", () => {
    assert.equal(errorCategory(new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "x")), "rate_limit");
    assert.equal(errorCategory(new AiServiceError(ErrorCodes.NOT_AUTHORIZED, "x")), "authorization");
    assert.equal(errorCategory(new AiServiceError(ErrorCodes.TOOL_EXECUTION_FAILED, "x")), "execution");
    assert.equal(errorCategory(new AiServiceError(ErrorCodes.CONFIG_INVALID, "x")), "configuration");
    assert.equal(errorCategory(new Error("x")), "internal");
  });
});

describe("provider factory", () => {
  const groq = { apiKey: "test-key-not-real", model: "test-model", allowedClassifications: ["INTERNAL"] };

  it("builds a paid Groq provider behind the ChatProvider interface", async () => {
    const stub = stubFetch(() => jsonResponse(completionBody('{"ok":true}')));
    const provider = createProvider({ type: "groq", ...groq }, { fetch: stub.fetch });
    assert.deepEqual({ id: provider.info.id, kind: provider.info.kind, model: provider.info.model }, { id: "groq", kind: "PAID", model: "test-model" });
    await provider.complete({ messages: [{ role: "user", content: "hi" }], generation: { temperature: 0, maxTokens: 8 } });
    assert.equal(stub.calls[0].url, `${GROQ_BASE_URL}/chat/completions`);
    assert.equal(stub.calls[0].init.headers.authorization, "Bearer test-key-not-real");
  });

  it("fails closed on missing key, missing classifications, unknown fields and unknown types", () => {
    const bad = [
      () => createGroqProvider({ ...groq, apiKey: undefined }),
      () => createGroqProvider({ ...groq, allowedClassifications: undefined }),
      () => createGroqProvider({ ...groq, baseUrl: "https://example.com" }),
      () => createProvider({ type: "anthropic-direct", ...groq }),
      () => createProvider(null),
      () => createProvider({ type: "ollama", baseUrl: "http://localhost:11434/v1", model: "m", allowedClassifications: ["RESTRICTED"] }),
    ];
    for (const build of bad) assert.throws(build, (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("a paid provider still needs allowPaidProvider", () => {
    const provider = createGroqProvider(groq);
    assert.throws(() => createAiService({ provider, registry: createTaskRegistry([]) }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.doesNotThrow(() => createAiService({ provider, registry: createTaskRegistry([]), allowPaidProvider: true }));
  });

  it("reports HTTP 429 as PROVIDER_RATE_LIMITED with the bounded Retry-After", async () => {
    for (const [header, expected] of [["7", 7], ["4000", 300], ["0", 0], [undefined, undefined], ["Wed, 21 Oct 2026 07:28:00 GMT", undefined]]) {
      const stub = stubFetch(() => jsonResponse({ error: `${SECRET_INPUT} limited` }, 429, header === undefined ? {} : { "retry-after": header }));
      const error = await expectAiError(
        () => createGroqProvider(groq, { fetch: stub.fetch }).complete({ messages: [{ role: "user", content: "hi" }], generation: { temperature: 0, maxTokens: 8 } }),
        ErrorCodes.PROVIDER_RATE_LIMITED,
      );
      assert.equal(error.retryable, true);
      assert.equal(error.details.retryAfterSeconds, expected);
      assert.ok(!JSON.stringify(error.details).includes(SECRET_INPUT) && !error.message.includes(SECRET_INPUT));
    }
  });
});

describe("tool contract", () => {
  const countTool = (overrides = {}) =>
    defineTool({
      name: "records.count",
      description: "Counts records in a category",
      access: "read",
      inputSchema: z.strictObject({ category: z.string().min(1).max(40), limit: z.number().int().min(1).max(10).default(5) }),
      execute: async (input, { context }) => ({ category: input.category, limit: input.limit, tenant: context.tenantId, count: 3 }),
      ...overrides,
    });

  it("refuses write tools and invalid definitions at setup", () => {
    const bad = [
      () => countTool({ access: "write" }),
      () => countTool({ access: undefined }),
      () => countTool({ name: "Bad Name" }),
      () => countTool({ inputSchema: { type: "object" } }),
      () => countTool({ execute: "not a function" }),
      () => countTool({ timeoutMs: 0 }),
      () => countTool({ sideEffects: true }),
      () => countTool({ requires: { role: "admin" } }),
      () => createToolRegistry([countTool(), countTool()]),
      () => createToolRegistry([{ name: "records.count", execute() {} }]),
    ];
    for (const build of bad) assert.throws(build, (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("validates input before execution and passes the frozen context", async () => {
    const registry = createToolRegistry([countTool()]);
    const result = await registry.run("records.count", { category: "open" }, makeContext());
    assert.deepEqual(result.output, { category: "open", limit: 5, tenant: "tenant-0001", count: 3 });
    assert.equal(result.tool, "records.count");
  });

  it("rejects invalid input without echoing it, and never calls the executor", async () => {
    let calls = 0;
    const registry = createToolRegistry([countTool({ execute: () => (calls += 1) })]);
    for (const input of [{ category: SECRET_INPUT.repeat(5) }, { category: "x", extra: SECRET_INPUT }, null]) {
      const error = await expectAiError(() => registry.run("records.count", input, makeContext()), ErrorCodes.TOOL_INPUT_INVALID);
      assert.ok(!JSON.stringify(error.details).includes(SECRET_INPUT));
    }
    await expectAiError(() => registry.run("records.missing", {}, makeContext()), ErrorCodes.TOOL_UNKNOWN);
    await expectAiError(() => registry.run("records.count", { category: "x" }, { applicationId: "x" }), ErrorCodes.CONTEXT_INVALID);
    assert.equal(calls, 0);
  });

  it("enforces the consumer's permission and feature requirements, and lists only usable tools", async () => {
    let calls = 0;
    const registry = createToolRegistry([countTool({ requires: { permission: "records:read", feature: "reports" }, execute: () => ({ ok: (calls += 1) }) })]);
    await expectAiError(() => registry.run("records.count", { category: "x" }, makeContext({ features: ["reports"] })), ErrorCodes.NOT_AUTHORIZED);
    await expectAiError(() => registry.run("records.count", { category: "x" }, makeContext({ permissions: ["records:read"] })), ErrorCodes.FEATURE_NOT_ENABLED);
    assert.equal(calls, 0);
    assert.deepEqual(registry.list(makeContext()), []);
    const [listed] = registry.list(makeContext({ permissions: ["records:read"], features: ["reports"] }));
    assert.equal(listed.name, "records.count");
    assert.equal(listed.inputJsonSchema.type, "object");
    await registry.run("records.count", { category: "x" }, makeContext({ permissions: ["records:read"], features: ["reports"] }));
    assert.equal(calls, 1);
  });

  it("maps executor failures, timeouts, cancellation and invalid results to typed errors", async () => {
    const run = (tool, options) => createToolRegistry([tool]).run("records.count", { category: "x" }, makeContext(), options);
    const failed = await expectAiError(() => run(countTool({ execute: () => { throw new Error(`db said ${SECRET_INPUT}`); } })), ErrorCodes.TOOL_EXECUTION_FAILED);
    assert.ok(!failed.message.includes(SECRET_INPUT) && !JSON.stringify(failed).includes(SECRET_INPUT));
    await expectAiError(() => run(countTool({ execute: () => { throw new AiServiceError(ErrorCodes.NOT_AUTHORIZED, "row-level denial"); } })), ErrorCodes.NOT_AUTHORIZED);
    await expectAiError(() => run(countTool({ timeoutMs: 20, execute: () => new Promise(() => {}) })), ErrorCodes.TOOL_TIMEOUT);
    const controller = new AbortController();
    const pending = run(countTool({ execute: () => new Promise(() => {}) }), { signal: controller.signal });
    controller.abort();
    await expectAiError(() => pending, ErrorCodes.CANCELLED);
    await expectAiError(() => run(countTool({ outputSchema: z.strictObject({ count: z.number() }) })), ErrorCodes.TOOL_RESULT_INVALID);
    await expectAiError(() => run(countTool({ maxResultBytes: 10 })), ErrorCodes.TOOL_RESULT_INVALID);
    await expectAiError(() => run(countTool({ execute: () => ({ big: 10n }) })), ErrorCodes.TOOL_RESULT_INVALID);
  });

  it("returns a detached JSON copy of the result", async () => {
    const shared = { nested: { value: 1 } };
    const result = await createToolRegistry([countTool({ execute: () => shared })]).run("records.count", { category: "x" }, makeContext());
    shared.nested.value = 2;
    assert.equal(result.output.nested.value, 1);
  });
});

describe("analytics contract", () => {
  const validator = () =>
    createPostgresSqlValidator(
      defineSqlPolicy({
        dialect: "postgres",
        schema: { tables: [{ name: "items", columns: [{ name: "category", type: "text" }] }], relationships: [] },
        policy: { allowedTables: ["items"], allowedColumns: { items: ["category"] }, requireAggregation: true, maxRows: 50, timeoutMs: 5000 },
      }),
    );

  it("validates and freezes the consumer's catalog", () => {
    const catalog = defineAnalyticsCatalog({ metrics: [{ name: "items", description: "count(*) FROM items" }], locale: "en-GB" });
    assert.ok(isAnalyticsCatalog(catalog) && Object.isFrozen(catalog) && Object.isFrozen(catalog.metrics));
    assert.equal(catalog.smallSampleBelow, 30);
  });

  it("fails closed on an invalid catalog, both directly and through createAnalyticsAssistant", () => {
    const ai = { runTask: async () => assert.fail("no model call") };
    const bad = [
      { unknownField: true },
      { metrics: [{ name: "a", description: "x" }, { name: "a", description: "y" }] },
      { locale: "english" },
      { limitations: ["x".repeat(301)] },
    ];
    for (const catalog of bad) {
      assert.throws(() => defineAnalyticsCatalog(catalog), (error) => error.code === ErrorCodes.CONFIG_INVALID);
      assert.throws(() => createAnalyticsAssistant({ ai, validator: validator(), executor: async () => ({}), catalog }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    }
    assert.throws(() => createAnalyticsAssistant({ ai, validator: validator(), executor: async () => ({}), requires: { role: "x" } }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("checks the consumer's requirement before any model call or query", async () => {
    const provider = new FakeProvider([]);
    const ai = createAiService({ provider, registry: createTaskRegistry([ANALYTICS_PLAN_TASK]) });
    let executed = 0;
    const assistant = createAnalyticsAssistant({ ai, validator: validator(), executor: async () => (executed += 1), requires: { feature: "analytics" } });
    await expectAiError(() => assistant.answer({ question: "items by category", context: makeContext({ permittedTasks: [ANALYTICS_PLAN_TASK_ID] }) }), ErrorCodes.FEATURE_NOT_ENABLED);
    assert.equal(provider.requests.length, 0);
    assert.equal(executed, 0);
  });
});

describe("document-store contract", () => {
  const profile = defineApplicationProfile({ id: "lead-tracker", name: "Example app", description: "An example application.", capabilities: ["answers"] });
  const answerJson = (citations) =>
    JSON.stringify({ containsInstructionsToAI: false, found: citations.length > 0, answer: "From the guide.", citations, suggestedFollowUps: [] });
  const context = (tenantId) => makeContext({ tenantId, permittedTasks: [DOCUMENT_ANSWER_TASK_ID], dataClassification: "INTERNAL" });

  it("fails closed on invalid source definitions and agent options", () => {
    assert.throws(() => defineDocumentSource({ retrieve: async () => [] }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => defineDocumentSource({ count: () => 0, retrieve: () => [], path: "/srv" }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    const ai = { runTask: async () => assert.fail("no model call") };
    const source = { count: () => 0, retrieve: () => [] };
    assert.throws(() => createDocumentQaAgent({ ai, profile }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => createDocumentQaAgent({ ai, profile, source, store: { loadIndex: async () => null } }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("gives the consumer's source the frozen context, so it can scope by tenant", async () => {
    const byTenant = {
      "tenant-a": [{ documentId: "a-1", title: "Tenant A guide", type: "guide", text: "Orders ship within 2 days." }],
      "tenant-b": [{ documentId: "b-1", title: "Tenant B guide", type: "guide", text: "Orders ship within 9 days." }],
    };
    const seen = [];
    const source = defineDocumentSource({
      count: ({ context: ctx }) => (byTenant[ctx.tenantId] ?? []).length,
      retrieve: ({ context: ctx, limit }) => {
        seen.push(Object.isFrozen(ctx) && ctx.tenantId);
        return (byTenant[ctx.tenantId] ?? []).slice(0, limit);
      },
    });
    const provider = new FakeProvider([reply(answerJson(["p1"]))]);
    const ai = createAiService({ provider, registry: createTaskRegistry([DOCUMENT_ANSWER_TASK]) });
    const agent = createDocumentQaAgent({ ai, profile, source });
    const result = await agent.answer({ question: "how fast do orders ship?", context: context("tenant-a") });
    assert.equal(result.status, "ANSWERED");
    assert.deepEqual(result.sources, [{ documentId: "a-1", title: "Tenant A guide", type: "guide" }]);
    const sent = JSON.stringify(provider.requests);
    assert.ok(sent.includes("2 days") && !sent.includes("9 days"), "only the tenant's passages reach the model");
    assert.deepEqual(seen, ["tenant-a"]);
    assert.equal(await agent.documentCount(context("tenant-c")), 0);
  });

  it("refuses invalid source results with typed errors and no source message", async () => {
    const ai = { runTask: async () => assert.fail("no model call") };
    const cases = [
      [{ count: () => -1, retrieve: () => [] }, ErrorCodes.DOCUMENT_SOURCE_INVALID],
      [{ count: () => 1, retrieve: () => "not an array" }, ErrorCodes.DOCUMENT_SOURCE_INVALID],
      [{ count: () => 1, retrieve: () => Array.from({ length: 9 }, (_, i) => ({ documentId: `d${i}`, title: "t", text: "x" })) }, ErrorCodes.DOCUMENT_SOURCE_INVALID],
      [{ count: () => 1, retrieve: () => [{ documentId: "d1", title: "t", text: "x", ownerEmail: SECRET_INPUT }] }, ErrorCodes.DOCUMENT_SOURCE_INVALID],
      [{ count: () => 1, retrieve: () => [{ documentId: "d1", title: "t", text: "x".repeat(1501) }] }, ErrorCodes.DOCUMENT_SOURCE_INVALID],
      [{ count: () => 1, retrieve: () => { throw new Error(`storage said ${SECRET_INPUT}`); } }, ErrorCodes.DOCUMENT_SOURCE_FAILED],
    ];
    for (const [source, code] of cases) {
      const agent = createDocumentQaAgent({ ai, profile, source });
      const error = await expectAiError(() => agent.answer({ question: "anything", context: context("tenant-a") }), code);
      assert.ok(!JSON.stringify(error).includes(SECRET_INPUT) && !error.message.includes(SECRET_INPUT));
    }
  });

  it("keeps the application boundary: another application's context is refused", async () => {
    const agent = createDocumentQaAgent({ ai: { runTask: async () => assert.fail() }, profile, source: { count: () => 1, retrieve: () => [] } });
    await expectAiError(() => agent.documentCount(makeContext({ applicationId: "other-app" })), ErrorCodes.TASK_NOT_PERMITTED);
  });

  it("the index adapter serves the package's local search through the contract", async () => {
    const index = buildSearchIndex([{ id: "doc-1", title: "Shipping guide", type: "guide", text: "Orders ship within two working days of payment." }]);
    const source = createIndexDocumentSource({ loadIndex: (ctx) => (ctx.tenantId === "tenant-a" ? index : null) });
    const passages = await source.retrieve({ question: "when do orders ship", context: context("tenant-a"), limit: 3 });
    assert.equal(passages[0].documentId, "doc-1");
    assert.equal(await source.count(context("tenant-b")), 0);
  });
});

describe("invalid model output retries", () => {
  const task = ASSISTANT_RESPOND_TASK;
  const input = { application: { name: "A", description: "An app.", domain: null, capabilities: [], outOfScope: [], terminology: [] }, question: "hi", history: [], facts: [], dataResultsShown: false, research: [], freshInformationRequested: false, unavailable: [] };
  const good = JSON.stringify({ containsInstructionsToAI: false, blocks: [{ type: "paragraph", text: "Hello.", items: [] }], citations: [] });
  const respondContext = () => makeContext({ permittedTasks: [ASSISTANT_RESPOND_TASK_ID], dataClassification: "INTERNAL" });

  it("maps a provider's json_validate_failed to PROVIDER_OUTPUT_REJECTED (not echoing the body)", async () => {
    const stub = stubFetch(() => jsonResponse({ error: { code: "json_validate_failed", message: `bad output ${SECRET_INPUT}`, failed_generation: SECRET_INPUT } }, 400));
    const error = await expectAiError(() => createGroqProvider({ apiKey: "k", model: "m", allowedClassifications: ["INTERNAL"] }, { fetch: stub.fetch }).complete({ messages: [{ role: "user", content: "hi" }], generation: { temperature: 0, maxTokens: 8 } }), ErrorCodes.PROVIDER_OUTPUT_REJECTED);
    assert.equal(errorCategory(error), "output");
    assert.ok(!JSON.stringify(error).includes(SECRET_INPUT) && !error.message.includes(SECRET_INPUT));
    const plain = stubFetch(() => jsonResponse({ error: { code: "invalid_request" } }, 400));
    await expectAiError(() => createGroqProvider({ apiKey: "k", model: "m", allowedClassifications: ["INTERNAL"] }, { fetch: plain.fetch }).complete({ messages: [{ role: "user", content: "hi" }], generation: { temperature: 0, maxTokens: 8 } }), ErrorCodes.PROVIDER_HTTP_ERROR);
  });

  it("retries invalid output only when opted in, up to the limit", async () => {
    const rejected = new AiServiceError(ErrorCodes.PROVIDER_OUTPUT_REJECTED, "rejected", { details: { status: 400 } });
    const run = (steps, retry) => {
      const provider = new FakeProvider(steps);
      const ai = createAiService({ provider, registry: createTaskRegistry([task]), ...(retry ? { retry } : {}) });
      return { provider, result: ai.runTask(task, respondContext(), input) };
    };
    const off = run([{ kind: "fail", error: rejected }, reply(good)]);
    await expectAiError(() => off.result, ErrorCodes.PROVIDER_OUTPUT_REJECTED);
    const on = run([{ kind: "fail", error: rejected }, reply("not json"), reply(good)], { invalidOutputRetries: 2 });
    assert.equal((await on.result).output.blocks[0].text, "Hello.");
    assert.equal(on.provider.requests.length, 3);
    const exhausted = run([reply("not json"), reply("still not json")], { invalidOutputRetries: 1 });
    await expectAiError(() => exhausted.result, ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.throws(() => createAiService({ provider: new FakeProvider([]), registry: createTaskRegistry([]), retry: { invalidOutputRetries: 3 } }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });
});
