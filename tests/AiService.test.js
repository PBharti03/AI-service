import "./helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { MAX_OUTPUT_CHARS, parseStructuredOutput, retryPolicySchema, withRetry } from "../src/core/AiService.js";
import { AI_BUSY_MESSAGE, AiServiceError, aiUserMessage, ANALYTICS_PLAN_TASK, ANALYTICS_PLAN_TASK_ID, assertAuthorized, ASSISTANT_RESPOND_TASK, ASSISTANT_RESPOND_TASK_ID, buildSearchIndex, createAiService, createAnalyticsAssistant, createDocumentQaAgent, createGroqProvider, createIndexDocumentSource, createProvider, createTaskRegistry, defineAnalyticsCatalog, defineApplicationProfile, defineDocumentSource, defineSqlPolicy, defineTask, DOCUMENT_ANSWER_TASK, DOCUMENT_ANSWER_TASK_ID, ErrorCategories, errorCategory, ErrorCodes, GROQ_BASE_URL, GROQ_DEFAULT_MODEL, hasFeature, hasPermission, isAnalyticsCatalog, isRateLimited, parseTrustedContext, rateLimitInfo } from "../src/index.js";
import { createPostgresSqlValidator } from "../src/sql/PostgresSqlValidator.js";
import { completionBody, expectAiError, fail, FakeProvider, jsonResponse, makeContext, recordingLogger, reply, sampleDefinition, sampleTask, stubFetch, VALID_OUTPUT } from "./helpers/Fixtures.js";

// Foundation
{
// Unit tests for the package's contracts and factories. Everything here is mocked (scripted provider,
// stub fetch, in-memory tools and document sources): these tests prove contract behaviour, not any
// application's data or integration.

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
    assert.equal(errorCategory(new AiServiceError(ErrorCodes.CAPABILITY_FAILED, "x")), "execution");
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
      () => createProvider({ type: "ollama", baseUrl: "http://localhost:11434/v1", model: "m", allowedClassifications: ["INTERNAL"] }),
    ];
    for (const build of bad) assert.throws(build, (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("uses the package's default Groq model unless the application names one", () => {
    assert.equal(GROQ_DEFAULT_MODEL, "openai/gpt-oss-120b");
    const withoutModel = { ...groq };
    delete withoutModel.model;
    assert.equal(createProvider({ type: "groq", ...withoutModel }).info.model, GROQ_DEFAULT_MODEL);
    assert.equal(createProvider({ type: "groq", ...groq }).info.model, "test-model");
    assert.throws(() => createProvider({ type: "groq", ...withoutModel, model: "" }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });

  it("a paid provider still needs allowPaidProvider", () => {
    const provider = createGroqProvider(groq);
    assert.throws(() => createAiService({ provider, registry: createTaskRegistry([]) }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.doesNotThrow(() => createAiService({ provider, registry: createTaskRegistry([]), allowPaidProvider: true }));
  });

  it("reports HTTP 429 as PROVIDER_RATE_LIMITED with the bounded Retry-After", async () => {
    for (const [header, expected] of [["7", 7], ["17", 17], ["225", 225], ["4000", 300], ["0", 0], [undefined, undefined], ["Wed, 21 Oct 2026 07:28:00 GMT", undefined]]) {
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
  const input = { application: { name: "A", description: "An app.", domain: null, capabilities: [], outOfScope: [], terminology: [] }, question: "hi", history: [], facts: [], dataResultsShown: false, freshInformationRequested: false, unavailable: [] };
  const good = JSON.stringify({ containsInstructionsToAI: false, blocks: [{ type: "paragraph", text: "Hello.", items: [] }] });
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
}

// CreateAiService
{
const input = { note: "Synthetic lead wants a two-bedroom flat near the metro.", internalReference: "crm-ref-001" };

function setup(steps, options = {}, provider) {
  const fake = new FakeProvider(steps);
  const usage = [];
  const service = createAiService({
    provider: provider ?? fake,
    registry: createTaskRegistry([sampleTask]),
    onUsage: (record) => {
      usage.push(record);
    },
    ...options,
  });
  return { fake, usage, service };
}

describe("createAiService: success", () => {
  it("returns validated output with usage and metadata", async () => {
    const { fake, usage, service } = setup([reply(VALID_OUTPUT)]);
    const result = await service.runTask(sampleTask, makeContext(), input);

    assert.deepEqual(result.output, { summary: "Customer wants a two-bedroom flat.", sentiment: "POSITIVE" });
    assert.equal(result.usage.attempts, 1);
    assert.equal(result.usage.promptTokens, 40);
    assert.equal(result.usage.completionTokens, 12);
    assert.deepEqual(result.meta, {
      taskId: "test.note-summary",
      taskVersion: 1,
      promptVersion: "v1",
      providerId: "fake",
      model: "fake-model",
      modelRevision: null,
      requestId: "req-0001",
    });

    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.outcome, "SUCCESS");
    assert.equal(usage[0].tenantId, "tenant-0001");
    assert.equal(usage[0].errorCode, null);

    const request = fake.requests[0];
    assert.ok(request);
    assert.deepEqual(
      request.messages.map((message) => message.role),
      ["system", "user"],
    );
    assert.ok(request.messages[0]?.content.includes("Summarise the note"));
    assert.ok(request.messages[1]?.content.includes("two-bedroom flat"));
    assert.equal(request.jsonSchema?.name, "test_note-summary");
  });

  it("sends only minimized fields to the model", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)]);
    await service.runTask(sampleTask, makeContext(), input);
    const userMessage = fake.requests[0]?.messages[1]?.content ?? "";
    assert.ok(!userMessage.includes("crm-ref-001"));
    assert.ok(!(fake.requests[0]?.messages[0]?.content ?? "").includes("two-bedroom"));
  });

  it("applies the application redaction hook after minimization", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)], {
      redact: (data) => ({ ...data, note: "[redacted]" }),
    });
    await service.runTask(sampleTask, makeContext(), input);
    const userMessage = fake.requests[0]?.messages[1]?.content ?? "";
    assert.ok(userMessage.includes("[redacted]"));
    assert.ok(!userMessage.includes("two-bedroom"));
  });
});

describe("createAiService: refusals before inference", () => {
  it("rejects an invalid context", async () => {
    const { fake, usage, service } = setup([reply(VALID_OUTPUT)]);
    await expectAiError(() => service.runTask(sampleTask, { ...makeContext(), tenantId: "" }, input), ErrorCodes.CONTEXT_INVALID);
    assert.equal(fake.requests.length, 0);
    assert.equal(usage.length, 0);
  });

  it("rejects a task that is not in the registry", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)]);
    const unregistered = defineTask({ ...sampleDefinition, id: "test.unregistered" });
    await expectAiError(
      () => service.runTask(unregistered, makeContext({ permittedTasks: ["test.unregistered"] }), input),
      ErrorCodes.TASK_UNKNOWN,
    );
    assert.equal(fake.requests.length, 0);
  });

  it("rejects a task the context does not permit", async () => {
    const { fake, usage, service } = setup([reply(VALID_OUTPUT)]);
    await expectAiError(
      () => service.runTask(sampleTask, makeContext({ permittedTasks: ["test.other-task"] }), input),
      ErrorCodes.TASK_NOT_PERMITTED,
    );
    assert.equal(fake.requests.length, 0);
    assert.equal(usage[0]?.outcome, "FAILURE");
    assert.equal(usage[0].errorCode, ErrorCodes.TASK_NOT_PERMITTED);
    assert.equal(usage[0].usage.attempts, 0);
  });

  it("rejects data more sensitive than the task allows", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)]);
    const error = await expectAiError(
      () => service.runTask(sampleTask, makeContext({ dataClassification: "RESTRICTED" }), input),
      ErrorCodes.CLASSIFICATION_NOT_ALLOWED,
    );
    assert.equal(error.details.reason, "task");
    assert.equal(fake.requests.length, 0);
  });

  it("rejects data the provider is not approved for", async () => {
    const syntheticOnly = new FakeProvider([reply(VALID_OUTPUT)], { allowedClassifications: ["SYNTHETIC"] });
    const { service } = setup([], {}, syntheticOnly);
    const error = await expectAiError(
      () => service.runTask(sampleTask, makeContext({ dataClassification: "INTERNAL" }), input),
      ErrorCodes.CLASSIFICATION_NOT_ALLOWED,
    );
    assert.equal(error.details.reason, "provider");
    assert.equal(syntheticOnly.requests.length, 0);
  });

  it("rejects invalid task input", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)]);
    await expectAiError(() => service.runTask(sampleTask, makeContext(), { note: "" }), ErrorCodes.INPUT_INVALID);
    await expectAiError(
      () => service.runTask(sampleTask, makeContext(), { note: "ok", tenantId: "tenant-9999" }),
      ErrorCodes.INPUT_INVALID,
    );
    assert.equal(fake.requests.length, 0);
  });
});

describe("createAiService: configuration", () => {
  it("refuses a paid provider unless explicitly allowed", async () => {
    const paid = new FakeProvider([reply(VALID_OUTPUT)], { kind: "PAID", id: "paid-test" });
    const registry = createTaskRegistry([sampleTask]);
    await expectAiError(() => createAiService({ provider: paid, registry }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => createAiService({ provider: paid, registry, allowPaidProvider: false }), ErrorCodes.CONFIG_INVALID);
    const allowed = createAiService({ provider: paid, registry, allowPaidProvider: true });
    assert.equal(allowed.providerInfo.kind, "PAID");
  });

  it("refuses objects that do not implement the provider contract", async () => {
    const registry = createTaskRegistry([sampleTask]);
    await expectAiError(() => createAiService({ provider: { info: { id: "x" } }, registry }), ErrorCodes.CONFIG_INVALID);
  });

  it("refuses unbounded retry policies", async () => {
    const registry = createTaskRegistry([sampleTask]);
    await expectAiError(
      () => createAiService({ provider: new FakeProvider([]), registry, retry: { maxRetries: 10 } }),
      ErrorCodes.CONFIG_INVALID,
    );
  });
});

describe("createAiService: output handling", () => {
  it("fails closed on malformed JSON and still meters the tokens used", async () => {
    const { usage, service } = setup([reply("not json at all")]);
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.equal(usage[0]?.outcome, "FAILURE");
    assert.equal(usage[0].usage.attempts, 1);
    assert.equal(usage[0].usage.promptTokens, 40);
  });

  it("fails closed on schema-invalid output", async () => {
    const { service } = setup([reply(JSON.stringify({ summary: "ok", sentiment: "EXCITED" }))]);
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.OUTPUT_SCHEMA_INVALID);
  });

  it("fails closed on truncated output", async () => {
    const { service } = setup([reply('{"summary":"Customer wants', "length")]);
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.OUTPUT_PARSE_FAILED);
  });

  it("fails closed when task validation rejects the output", async () => {
    const strictTask = defineTask({
      ...sampleDefinition,
      id: "test.strict-summary",
      postValidate: (output) =>
        output.sentiment === "NEGATIVE" ? { ok: false, reason: "negative_not_supported" } : { ok: true },
    });
    const service = createAiService({
      provider: new FakeProvider([reply(JSON.stringify({ summary: "Unhappy lead.", sentiment: "NEGATIVE" }))]),
      registry: createTaskRegistry([strictTask]),
    });
    const error = await expectAiError(
      () => service.runTask(strictTask, makeContext({ permittedTasks: ["test.strict-summary"] }), input),
      ErrorCodes.OUTPUT_REJECTED,
    );
    assert.equal(error.details.reason, "negative_not_supported");
  });

  it("wraps unexpected provider errors without exposing their message", async () => {
    const { service } = setup([fail(new Error("SYNTHETIC internal stack detail"))]);
    const error = await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.INTERNAL_ERROR);
    assert.ok(!error.message.includes("SYNTHETIC"));
    assert.equal(error.retryable, false);
  });
});

describe("createAiService: retries and cancellation", () => {
  const timeout = () => new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "timed out", { retryable: true });

  it("does not retry by default", async () => {
    const { fake, usage, service } = setup([fail(timeout()), reply(VALID_OUTPUT)]);
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.PROVIDER_TIMEOUT);
    assert.equal(fake.requests.length, 1);
    assert.equal(usage[0]?.usage.attempts, 1);
  });

  it("retries retryable provider errors when enabled", async () => {
    const { fake, service } = setup([fail(timeout()), reply(VALID_OUTPUT)], { retry: { maxRetries: 1, baseDelayMs: 0 } });
    const result = await service.runTask(sampleTask, makeContext(), input);
    assert.equal(result.usage.attempts, 2);
    assert.equal(fake.requests.length, 2);
  });

  it("never retries invalid output", async () => {
    const { fake, service } = setup([reply("not json"), reply(VALID_OUTPUT)], { retry: { maxRetries: 2, baseDelayMs: 0 } });
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.equal(fake.requests.length, 1);
  });

  it("cancels an in-flight task", async () => {
    const { service } = setup([{ kind: "hang" }]);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expectAiError(
      () => service.runTask(sampleTask, makeContext(), input, { signal: controller.signal }),
      ErrorCodes.CANCELLED,
    );
  });
});

describe("createAiService: usage recording", () => {
  it("fails a successful task when usage cannot be recorded", async () => {
    const { logger, entries } = recordingLogger();
    const { service } = setup([reply(VALID_OUTPUT)], {
      logger,
      onUsage: () => Promise.reject(new Error("meter down")),
    });
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.USAGE_RECORDING_FAILED);
    assert.ok(entries.some((entry) => entry.level === "error"));
  });

  it("keeps the original error when usage recording also fails", async () => {
    const { logger, entries } = recordingLogger();
    const { service } = setup([reply("not json")], {
      logger,
      onUsage: () => {
        throw new Error("meter down");
      },
    });
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.ok(entries.some((entry) => entry.level === "error" && entry.message === "AI usage recording failed"));
  });
});

describe("schema generation for constrained decoding", () => {
  it("sends the task's JSON schema with the request", async () => {
    const { fake, service } = setup([reply(VALID_OUTPUT)]);
    await service.runTask(sampleTask, makeContext(), input);
    const schema = fake.requests[0]?.jsonSchema?.schema;
    assert.ok(schema.properties && "summary" in schema.properties && "sentiment" in schema.properties);
    assert.deepEqual(schema.required, ["summary", "sentiment"]);
    assert.equal(z.toJSONSchema(sampleTask.outputSchema, { io: "input" }).type, "object");
  });
});

describe("createAiService: provider rate limits (HTTP 429)", () => {
  const limited = (retryAfterSeconds) =>
    fail(new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "Provider rate limit reached (HTTP 429)", { retryable: true, details: { status: 429, retryAfterSeconds } }));

  it("after a 429, repeated requests fail at once without calling the provider until the cooldown ends", async () => {
    let clockMs = 1_000_000;
    const { entries, logger } = recordingLogger();
    const { fake, service } = setup([limited(17), reply(VALID_OUTPUT)], { clock: () => clockMs, logger });
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(fake.requests.length, 1);

    // Five rapid repeats within the 17 s: refused by the cooldown, the provider is not called again.
    for (let index = 0; index < 5; index += 1) {
      clockMs += 1_000;
      const error = await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.PROVIDER_RATE_LIMITED);
      assert.equal(error.details.cooldown, true);
      assert.equal(error.details.retryAfterSeconds, 17 - (index + 1));
    }
    assert.equal(fake.requests.length, 1);

    // The real numbers are in the log metadata.
    const first = entries.find((entry) => entry.message === "AI task failed");
    assert.equal(first.meta.providerStatus, 429);
    assert.equal(first.meta.retryAfterSeconds, 17);
    assert.equal(first.meta.cooldown, false);

    clockMs += 12_000;
    const result = await service.runTask(sampleTask, makeContext(), input);
    assert.equal(result.output.sentiment, "POSITIVE");
    assert.equal(fake.requests.length, 2);
  });

  it("caps the cooldown for a long Retry-After (225 s) at one minute", async () => {
    let clockMs = 0;
    const { fake, service } = setup([limited(225), reply(VALID_OUTPUT)], { clock: () => clockMs });
    await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.PROVIDER_RATE_LIMITED);
    clockMs = 59_000;
    const refused = await expectAiError(() => service.runTask(sampleTask, makeContext(), input), ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(refused.details.retryAfterSeconds, 1);
    clockMs = 60_001;
    await service.runTask(sampleTask, makeContext(), input);
    assert.equal(fake.requests.length, 2);
  });

  it("a short Retry-After is retried once inside the request, and the request then succeeds", async () => {
    const { fake, service } = setup([limited(0), reply(VALID_OUTPUT)]);
    const result = await service.runTask(sampleTask, makeContext(), input);
    assert.equal(result.usage.attempts, 2);
    assert.equal(fake.requests.length, 2);
  });
});
}

// Retry
{
const retryable = () => new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "timed out", { retryable: true });
const permanent = () => new AiServiceError(ErrorCodes.PROVIDER_HTTP_ERROR, "bad request", { retryable: false });

function recordingWait() {
  const delays = [];
  return {
    delays,
    wait: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  };
}

describe("retry policy", () => {
  it("defaults to zero retries", async () => {
    const policy = retryPolicySchema.parse({});
    assert.equal(policy.maxRetries, 0);
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(retryable());
          },
          policy,
          undefined,
        ),
      ErrorCodes.PROVIDER_TIMEOUT,
    );
    assert.equal(calls, 1);
  });

  it("retries retryable errors up to the bound with exponential delays", async () => {
    const { wait, delays } = recordingWait();
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(retryable());
          },
          { maxRetries: 2, baseDelayMs: 100 },
          undefined,
          wait,
        ),
      ErrorCodes.PROVIDER_TIMEOUT,
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it("stops retrying once an attempt succeeds", async () => {
    const { wait } = recordingWait();
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(retryable()) : Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 0 },
      undefined,
      wait,
    );
    assert.equal(value, "ok");
    assert.equal(calls, 2);
  });

  it("never retries non-retryable or unknown errors", async () => {
    const { wait } = recordingWait();
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(permanent());
          },
          { maxRetries: 3, baseDelayMs: 0 },
          undefined,
          wait,
        ),
      ErrorCodes.PROVIDER_HTTP_ERROR,
    );
    assert.equal(calls, 1);

    let plainCalls = 0;
    await assert.rejects(
      withRetry(
        () => {
          plainCalls += 1;
          return Promise.reject(new Error("plain"));
        },
        { maxRetries: 3, baseDelayMs: 0 },
        undefined,
        wait,
      ),
    );
    assert.equal(plainCalls, 1);
  });

  it("is cancelled while waiting between attempts", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);
    const started = Date.now();
    await expectAiError(
      () => withRetry(() => Promise.reject(retryable()), { maxRetries: 3, baseDelayMs: 10_000 }, controller.signal),
      ErrorCodes.CANCELLED,
    );
    assert.ok(Date.now() - started < 5_000);
  });

  it("rejects unbounded policies", () => {
    assert.equal(retryPolicySchema.safeParse({ maxRetries: 4 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ maxRetries: -1 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ baseDelayMs: 60_000 }).success, false);
  });
});

describe("rate-limit retry (HTTP 429)", () => {
  const limited = (retryAfterSeconds) =>
    new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "Provider rate limit reached (HTTP 429)", { retryable: true, details: retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds } });
  const run = async (errors, policy = {}) => {
    const { wait, delays } = recordingWait();
    let calls = 0;
    const outcome = await withRetry(
      () => {
        calls += 1;
        const error = errors[calls - 1];
        return error ? Promise.reject(error) : Promise.resolve("ok");
      },
      retryPolicySchema.parse(policy),
      undefined,
      wait,
    ).catch((error) => error);
    return { outcome, calls, delays };
  };

  it("retries once after a short Retry-After (3 s), waiting exactly that long", async () => {
    const { outcome, calls, delays } = await run([limited(3)]);
    assert.equal(outcome, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(delays, [3000]);
  });

  it("does not wait out long Retry-After values (17 s, 225 s): the error returns at once", async () => {
    for (const seconds of [17, 225]) {
      const { outcome, calls, delays } = await run([limited(seconds)]);
      assert.equal(outcome.code, ErrorCodes.PROVIDER_RATE_LIMITED);
      assert.equal(outcome.details.retryAfterSeconds, seconds, "the provider's value is kept for logs and metadata");
      assert.equal(calls, 1);
      assert.deepEqual(delays, []);
    }
  });

  it("does not retry without a Retry-After, and retries at most once", async () => {
    assert.equal((await run([limited(undefined)])).calls, 1);
    const repeated = await run([limited(1), limited(1), limited(1)]);
    assert.equal(repeated.outcome.code, ErrorCodes.PROVIDER_RATE_LIMITED);
    assert.equal(repeated.calls, 2);
  });

  it("general retries (maxRetries) never apply to rate limits, and rate-limit retries can be turned off", async () => {
    assert.equal((await run([limited(undefined), limited(undefined)], { maxRetries: 3, baseDelayMs: 0 })).calls, 1);
    assert.equal((await run([limited(2)], { rateLimitRetries: 0 })).calls, 1);
    assert.equal(retryPolicySchema.safeParse({ rateLimitRetries: 2 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ rateLimitMaxWaitMs: 60_000 }).success, false);
  });
});
}

// StructuredOutput
{
const schema = z.strictObject({ summary: z.string().max(50), score: z.number().min(0).max(1) });

describe("parseStructuredOutput", () => {
  it("returns validated output for a complete JSON object", () => {
    assert.deepEqual(parseStructuredOutput('{"summary":"ok","score":0.5}', schema, "stop"), { summary: "ok", score: 0.5 });
  });

  it("rejects truncated and otherwise incomplete responses", async () => {
    const truncated = await expectAiError(
      () => parseStructuredOutput('{"summary":"ok","score":0.5}', schema, "length"),
      ErrorCodes.OUTPUT_PARSE_FAILED,
    );
    assert.equal(truncated.details.reason, "truncated");
    const other = await expectAiError(
      () => parseStructuredOutput('{"summary":"ok","score":0.5}', schema, "other"),
      ErrorCodes.OUTPUT_PARSE_FAILED,
    );
    assert.equal(other.details.reason, "unexpected_finish");
  });

  it("rejects malformed JSON without quoting it", async () => {
    const content = '{"summary": "SYNTHETIC-PRIVATE-TEXT", score: }';
    const error = await expectAiError(() => parseStructuredOutput(content, schema, "stop"), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes("SYNTHETIC-PRIVATE-TEXT"));
    assert.ok(!JSON.stringify(error.details).includes("SYNTHETIC-PRIVATE-TEXT"));
  });

  it("does not extract JSON from Markdown fences or surrounding prose", async () => {
    await expectAiError(
      () => parseStructuredOutput('```json\n{"summary":"ok","score":0.5}\n```', schema, "stop"),
      ErrorCodes.OUTPUT_PARSE_FAILED,
    );
    await expectAiError(
      () => parseStructuredOutput('Here you go: {"summary":"ok","score":0.5}', schema, "stop"),
      ErrorCodes.OUTPUT_PARSE_FAILED,
    );
    await expectAiError(() => parseStructuredOutput("", schema, "stop"), ErrorCodes.OUTPUT_PARSE_FAILED);
  });

  it("rejects schema violations, including extra keys and out-of-range values", async () => {
    await expectAiError(
      () => parseStructuredOutput('{"summary":"ok","score":0.5,"tenantId":"tenant-9999"}', schema, "stop"),
      ErrorCodes.OUTPUT_SCHEMA_INVALID,
    );
    await expectAiError(
      () => parseStructuredOutput('{"summary":"ok","score":2}', schema, "stop"),
      ErrorCodes.OUTPUT_SCHEMA_INVALID,
    );
    await expectAiError(() => parseStructuredOutput('{"summary":"ok"}', schema, "stop"), ErrorCodes.OUTPUT_SCHEMA_INVALID);
    await expectAiError(() => parseStructuredOutput("[]", schema, "stop"), ErrorCodes.OUTPUT_SCHEMA_INVALID);
  });

  it("rejects oversized output before parsing", async () => {
    const huge = `{"summary":"${"a".repeat(MAX_OUTPUT_CHARS)}","score":0}`;
    const error = await expectAiError(() => parseStructuredOutput(huge, schema, "stop"), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.equal(error.details.reason, "too_large");
  });
});
}

// UserMessages
{
// The user-facing message for AI errors: generic for rate limits, with the provider's details kept apart.

const limited = (details) => new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "Provider rate limit reached (HTTP 429)", { retryable: true, details });

describe("user messages for AI errors", () => {
  it("never shows the provider's wait to users, whatever its Retry-After (17 s, 225 s, none)", () => {
    assert.equal(AI_BUSY_MESSAGE, "AI is temporarily busy. Please try again shortly.");
    for (const details of [{ status: 429, retryAfterSeconds: 17 }, { status: 429, retryAfterSeconds: 225 }, { status: 429 }, { status: 429, retryAfterSeconds: 3, cooldown: true }]) {
      const message = aiUserMessage(limited(details), "fallback");
      assert.equal(message, AI_BUSY_MESSAGE);
      assert.doesNotMatch(message, /\d/);
    }
  });

  it("keeps the provider's status and wait as structured metadata", () => {
    assert.deepEqual(rateLimitInfo(limited({ status: 429, retryAfterSeconds: 225 })), { status: 429, retryAfterSeconds: 225, cooldown: false });
    assert.deepEqual(rateLimitInfo(limited({ status: 429, retryAfterSeconds: 4, cooldown: true })), { status: 429, retryAfterSeconds: 4, cooldown: true });
    assert.deepEqual(rateLimitInfo(limited({ status: 429 })), { status: 429, retryAfterSeconds: null, cooldown: false });
  });

  it("leaves other errors to the application's own message", () => {
    const timeout = new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "timed out", { retryable: true });
    assert.equal(aiUserMessage(timeout, "The assistant could not answer."), "The assistant could not answer.");
    assert.equal(isRateLimited(timeout), false);
    assert.equal(rateLimitInfo(new Error("x")), null);
  });
});
}

// Tasks
{
const outputSchema = z.strictObject({ label: z.string() });
const inputSchema = z.strictObject({ text: z.string() });

const baseFields = {
  id: "test.labeller",
  version: 1,
  promptVersion: "v1",
  description: "Synthetic labelling task",
  instructions: "Label the text.",
  dataLabel: "text",
  generation: { temperature: 0, maxTokens: 64 },
  maxClassification: "SYNTHETIC",
};

function definition(overrides = {}) {
  return { ...baseFields, inputSchema, outputSchema, ...overrides };
}

describe("defineTask", () => {
  it("returns a frozen task with a generated JSON schema", () => {
    const task = defineTask(definition());
    assert.ok(Object.isFrozen(task));
    assert.ok(Object.isFrozen(task.generation));
    assert.ok(Object.isFrozen(task.outputJsonSchema));
    assert.equal(task.outputJsonSchema.type, "object");
    assert.equal(task.outputJsonSchema.additionalProperties, false);
  });

  it("rejects invalid ids, versions and generation settings", async () => {
    await expectAiError(() => defineTask(definition({ id: "NoDots" })), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => defineTask(definition({ version: 0 })), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => defineTask(definition({ promptVersion: "1" })), ErrorCodes.CONFIG_INVALID);
    await expectAiError(
      () => defineTask(definition({ generation: { temperature: 5, maxTokens: 64 } })),
      ErrorCodes.CONFIG_INVALID,
    );
    await expectAiError(() => defineTask(definition({ instructions: "   " })), ErrorCodes.CONFIG_INVALID);
  });

  it("rejects output schemas that are not JSON objects or cannot be represented", async () => {
    await expectAiError(() => defineTask({ ...baseFields, inputSchema, outputSchema: z.string() }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(
      () => defineTask({ ...baseFields, inputSchema, outputSchema: z.strictObject({ value: z.bigint() }) }),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it("refuses unsupported fields such as tools", async () => {
    const withTools = { ...definition(), tools: [{ type: "function", function: { name: "run_sql" } }] };
    const error = await expectAiError(() => defineTask(withTools), ErrorCodes.CONFIG_INVALID);
    assert.equal(error.details.field, "tools");
  });

  it("rejects schemas that are not Zod schemas", async () => {
    const notZod = { safeParse: () => ({ success: true }) };
    await expectAiError(() => defineTask(definition({ outputSchema: notZod })), ErrorCodes.CONFIG_INVALID);
  });
});

describe("createTaskRegistry", () => {
  it("looks tasks up by id and lists ids", () => {
    const registry = createTaskRegistry([sampleTask]);
    assert.equal(registry.get(sampleTask.id), sampleTask);
    assert.equal(registry.get("test.missing"), undefined);
    assert.deepEqual(registry.ids, [sampleTask.id]);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.ids));
  });

  it("rejects duplicate task ids", async () => {
    const first = defineTask(definition());
    const second = defineTask(definition({ description: "Same id, different object" }));
    const error = await expectAiError(() => createTaskRegistry([first, second]), ErrorCodes.CONFIG_INVALID);
    assert.equal(error.details.taskId, "test.labeller");
  });

  it("refuses objects that were not created by defineTask", async () => {
    const forged = { ...defineTask(definition()) };
    await expectAiError(() => createTaskRegistry([forged]), ErrorCodes.CONFIG_INVALID);
  });

  it("only recognises the exact registered task object", () => {
    const registered = defineTask(definition());
    const lookalike = defineTask(definition());
    const registry = createTaskRegistry([registered]);
    assert.equal(registry.has(registered), true);
    assert.equal(registry.has(lookalike), false);
  });
});
}

// TrustedContext
{
describe("parseTrustedContext", () => {
  it("accepts a well-formed context and returns a copy", () => {
    const input = makeContext({ metadata: { locale: "hi-IN", channel: "web" } });
    const parsed = parseTrustedContext(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
  });

  it("rejects a missing tenant", async () => {
    const withoutTenant = { ...makeContext() };
    delete withoutTenant.tenantId;
    await expectAiError(() => parseTrustedContext(withoutTenant), ErrorCodes.CONTEXT_INVALID);
  });

  it("rejects unknown fields such as a role or permission claim", async () => {
    await expectAiError(() => parseTrustedContext({ ...makeContext(), role: "ADMIN" }), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(
      () => parseTrustedContext({ ...makeContext(), actor: { type: "USER", userId: "user-0001", isAdmin: true } }),
      ErrorCodes.CONTEXT_INVALID,
    );
  });

  it("rejects malformed identifiers and classifications", async () => {
    await expectAiError(() => parseTrustedContext(makeContext({ tenantId: "tenant 1; DROP" })), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(() => parseTrustedContext(makeContext({ requestId: "" })), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(
      () => parseTrustedContext({ ...makeContext(), dataClassification: "PUBLIC" }),
      ErrorCodes.CONTEXT_INVALID,
    );
    await expectAiError(
      () => parseTrustedContext(makeContext({ permittedTasks: ["Not A Task Id"] })),
      ErrorCodes.CONTEXT_INVALID,
    );
  });

  it("reports schema paths without echoing received values", async () => {
    const error = await expectAiError(
      () => parseTrustedContext(makeContext({ tenantId: "bad value with spaces" })),
      ErrorCodes.CONTEXT_INVALID,
    );
    assert.equal(error.details.paths, "tenantId");
    assert.ok(!JSON.stringify(error.details).includes("bad value"));
    assert.ok(!error.message.includes("bad value"));
  });

  it("rejects non-object input", async () => {
    await expectAiError(() => parseTrustedContext(null), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(() => parseTrustedContext("tenant-0001"), ErrorCodes.CONTEXT_INVALID);
  });
});
}
