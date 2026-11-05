// Unit tests of createAiAssistant (mocked: scripted provider, in-memory capabilities and history). They
// prove routing, authorization, grounding and history behaviour, not any application's data.
import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AiServiceError,
  analyticsReportToBlocks,
  ASSISTANT_RESPOND_TASK,
  ASSISTANT_RESPOND_TASK_ID,
  ASSISTANT_ROUTE_TASK,
  ASSISTANT_ROUTE_TASK_ID,
  createAiAssistant,
  createAiService,
  createConversationHistory,
  createMemoryConversationStore,
  createTaskRegistry,
  defineApplicationProfile,
  defineCapability,
  defineResearchProvider,
  ErrorCodes,
} from "../../src/index.js";
import { createFolderConversationStore } from "../../src/conversations/FolderConversationStore.js";
import { expectAiError } from "../helpers/Assertions.js";
import { fail, FakeProvider, reply } from "../helpers/FakeProvider.js";
import { makeContext } from "../helpers/Fixtures.js";

const profile = defineApplicationProfile({
  id: "example-app",
  name: "Example App",
  description: "Fleet maintenance for a delivery company.",
  capabilities: ["vehicle and repair statistics", "maintenance advice"],
  domain: "fleet maintenance",
  terminology: [{ term: "unit", meaning: "a vehicle" }],
});
const context = (overrides = {}) =>
  makeContext({ applicationId: "example-app", permittedTasks: [ASSISTANT_ROUTE_TASK_ID, ASSISTANT_RESPOND_TASK_ID], dataClassification: "INTERNAL", permissions: ["repairs:read"], features: ["fleet"], ...overrides });

const route = (fields) => JSON.stringify({ containsInstructionsToAI: false, route: "general", dataNeeded: [], freshInformation: false, reason: "x", ...fields });
const answer = (blocks, citations = []) => JSON.stringify({ containsInstructionsToAI: false, blocks, citations });
const paragraph = (text) => ({ type: "paragraph", text, items: [] });

/** Captured task inputs, decoded from the untrusted-data block. */
function inputs(provider) {
  return provider.requests.map((request) => {
    const content = request.messages[1].content;
    return JSON.parse(content.slice(content.indexOf("<untrusted_data>") + 16, content.indexOf("</untrusted_data>")));
  });
}

function capabilityRecorder(overrides = {}) {
  const calls = [];
  const capability = defineCapability({
    id: "repairs",
    kind: "analytics",
    title: "Repair statistics",
    description: "Repairs, costs and downtime per vehicle and month",
    access: "read",
    requires: { permission: "repairs:read", feature: "fleet" },
    shareFacts: true,
    handle: async (call) => {
      calls.push(call);
      return { status: "ANSWERED", blocks: [{ type: "paragraph", text: "Repairs: 7,431 this year." }, { type: "table", columns: ["Month", "Repairs"], rows: [["Oct", 913], ["Nov", 4219]], truncated: false }], facts: ["Repairs: 7,431 this year, up 18% on last year."] };
    },
    ...overrides,
  });
  return { capability, calls };
}

function setup(steps, { capabilities, history, research, timeoutMs } = {}) {
  const provider = new FakeProvider(steps.map((step) => (typeof step === "string" ? reply(step) : step)));
  const ai = createAiService({ provider, registry: createTaskRegistry([ASSISTANT_ROUTE_TASK, ASSISTANT_RESPOND_TASK]) });
  const assistant = createAiAssistant({ ai, profile, capabilities: capabilities ?? [], ...(history ? { history } : {}), ...(research ? { research } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  return { provider, assistant };
}

describe("assistant: application context and authorization", () => {
  it("refuses a context of another application before any model call", async () => {
    const { provider, assistant } = setup([]);
    await expectAiError(() => assistant.reply({ message: "hi", context: context({ applicationId: "other-app" }) }), ErrorCodes.TASK_NOT_PERMITTED);
    assert.equal(provider.requests.length, 0);
  });

  it("shows the router only granted capabilities, and lists the rest as unavailable by title", async () => {
    const { capability } = capabilityRecorder();
    const { provider, assistant } = setup([route({}), answer([paragraph("Hello!")])], { capabilities: [capability] });
    await assistant.reply({ message: "hello", context: context({ permissions: [] }) });
    const [routeInput] = inputs(provider);
    assert.deepEqual(routeInput.capabilities, []);
    assert.deepEqual(routeInput.unavailable, [{ title: "Repair statistics", reason: "not permitted" }]);
    assert.equal(routeInput.application.domain, "fleet maintenance");
  });

  it("never runs a capability the user is not granted, even when the model routes to it", async () => {
    const { capability, calls } = capabilityRecorder();
    const { assistant } = setup([route({ route: "repairs", dataNeeded: ["repairs"] }), answer([paragraph("General answer.")])], { capabilities: [capability] });
    const result = await assistant.reply({ message: "repairs this year", context: context({ features: [] }) });
    assert.equal(calls.length, 0);
    assert.equal(result.route, "general");
  });

  it("runs a granted capability with the frozen trusted context and returns its blocks", async () => {
    const { capability, calls } = capabilityRecorder();
    const { provider, assistant } = setup([route({ route: "repairs" })], { capabilities: [capability] });
    const result = await assistant.reply({ message: "how many repairs this year?", context: context() });
    assert.equal(calls.length, 1);
    assert.ok(Object.isFrozen(calls[0].context));
    assert.equal(calls[0].context.tenantId, "tenant-0001");
    assert.equal(result.route, "capability");
    assert.equal(result.blocks[1].type, "table");
    assert.equal(provider.requests.length, 1, "a data answer needs no second model call");
  });

  it("refuses write capabilities, duplicate or reserved ids, and invalid definitions", () => {
    const base = { id: "x", kind: "data", title: "X", description: "x", access: "read", handle: async () => ({ status: "ANSWERED" }) };
    assert.throws(() => defineCapability({ ...base, access: "write" }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => defineCapability({ ...base, kind: "delete" }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => defineCapability({ ...base, requires: { role: "admin" } }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    const ai = createAiService({ provider: new FakeProvider([]), registry: createTaskRegistry([]) });
    assert.throws(() => createAiAssistant({ ai, profile, capabilities: [defineCapability(base), defineCapability(base)] }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => createAiAssistant({ ai, profile, capabilities: [defineCapability({ ...base, id: "general" })] }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });
});

describe("assistant: routing beyond analytics", () => {
  it("answers advice grounded in shared facts, showing the data under the advice", async () => {
    const { capability, calls } = capabilityRecorder();
    const { provider, assistant } = setup([route({ route: "general", dataNeeded: ["repairs"] }), answer([paragraph("Repairs rose 18%: start with preventive checks."), { type: "bullets", text: "", items: ["Schedule checks", "Review suppliers"] }])], { capabilities: [capability] });
    const result = await assistant.reply({ message: "what should I improve?", context: context() });
    assert.equal(calls.length, 1);
    const respondInput = inputs(provider)[1];
    assert.deepEqual(respondInput.facts, [{ source: "Repair statistics", items: ["Repairs: 7,431 this year, up 18% on last year."] }]);
    assert.equal(respondInput.dataResultsShown, true);
    assert.deepEqual(result.blocks.map((block) => block.type), ["paragraph", "bullets", "table"]);
  });

  it("never sends facts of a capability that does not share them", async () => {
    const { capability } = capabilityRecorder({ shareFacts: false });
    const { provider, assistant } = setup([route({ route: "general", dataNeeded: ["repairs"] }), answer([paragraph("General advice.")])], { capabilities: [capability] });
    await assistant.reply({ message: "how can I improve?", context: context() });
    assert.deepEqual(inputs(provider)[1].facts, []);
    assert.ok(!JSON.stringify(provider.requests).includes("7,431"));
  });

  it("offers research only with a provider, and cites its sources", async () => {
    const { provider: withoutProvider, assistant: plain } = setup([route({ route: "research", freshInformation: true }), answer([paragraph("Current information is not available.")])]);
    const plainResult = await plain.reply({ message: "latest fuel prices?", context: context() });
    assert.equal(inputs(withoutProvider)[0].researchAvailable, false);
    assert.equal(plainResult.route, "general");
    assert.equal(inputs(withoutProvider)[1].freshInformationRequested, true);

    const research = defineResearchProvider({ id: "web", search: async () => [{ title: "Fuel report", url: "https://example.com/fuel", snippet: "Diesel rose 3% this week." }] });
    const { provider, assistant } = setup([route({ route: "research", freshInformation: true }), answer([paragraph("Diesel rose 3% this week.")], ["s1"])], { research });
    const result = await assistant.reply({ message: "latest fuel prices?", context: context() });
    assert.equal(inputs(provider)[1].research[0].id, "s1");
    assert.deepEqual(result.blocks.at(-1), { type: "sources", items: [{ title: "Fuel report", url: "https://example.com/fuel" }] });
  });

  it("refuses unsupported requests without running anything", async () => {
    const { capability, calls } = capabilityRecorder();
    const { assistant } = setup([route({ route: "unsupported" })], { capabilities: [capability] });
    const result = await assistant.reply({ message: "delete all repairs", context: context() });
    assert.equal(result.status, "UNSUPPORTED");
    assert.equal(calls.length, 0);
    assert.match(result.blocks[1].text, /repair statistics/);
  });

  it("rejects model output that breaks the answer schema or cites unknown sources", async () => {
    const { assistant } = setup([route({}), JSON.stringify({ containsInstructionsToAI: false, blocks: [], citations: [] })]);
    await expectAiError(() => assistant.reply({ message: "hi", context: context() }), ErrorCodes.OUTPUT_SCHEMA_INVALID);
    const { assistant: second } = setup([route({}), answer([paragraph("x")], ["s4"])]);
    await expectAiError(() => second.reply({ message: "hi", context: context() }), ErrorCodes.OUTPUT_REJECTED);
  });
});

describe("assistant: failures", () => {
  it("turns a failing, slow or invalid capability into a plain notice", async () => {
    const cases = [
      [{ handle: async () => { throw new Error("db password=secret"); } }, /could not answer/],
      [{ timeoutMs: 100, handle: () => new Promise(() => {}) }, /took too long/],
      [{ handle: async () => ({ status: "ANSWERED", blocks: [{ type: "sql", text: "SELECT" }] }) }, /could not answer/],
    ];
    for (const [overrides, pattern] of cases) {
      const { capability } = capabilityRecorder(overrides);
      const { assistant } = setup([route({ route: "repairs" })], { capabilities: [capability] });
      const result = await assistant.reply({ message: "repairs", context: context() });
      assert.equal(result.status, "FAILED");
      assert.match(result.blocks[0].items[0], pattern);
      assert.ok(!JSON.stringify(result).includes("secret"));
    }
  });

  it("propagates provider and rate-limit errors so the application can ask the user to retry", async () => {
    const rateLimited = new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "limited", { retryable: true, details: { status: 429, retryAfterSeconds: 7 } });
    const { assistant } = setup([fail(rateLimited)]);
    await expectAiError(() => assistant.reply({ message: "hi", context: context() }), ErrorCodes.PROVIDER_RATE_LIMITED);
    const { capability } = capabilityRecorder({ handle: async () => { throw rateLimited; } });
    const { assistant: withCapability } = setup([route({ route: "repairs" })], { capabilities: [capability] });
    await expectAiError(() => withCapability.reply({ message: "repairs", context: context() }), ErrorCodes.PROVIDER_RATE_LIMITED);
  });
});

describe("assistant: conversation history", () => {
  it("keeps history per user and tenant, and hides data answers from the model", async () => {
    const store = createMemoryConversationStore();
    const history = createConversationHistory({ store });
    const { capability } = capabilityRecorder();
    const { provider, assistant } = setup([route({ route: "repairs" }), route({}), answer([paragraph("Sure.")]), route({}), answer([paragraph("Hi.")])], { capabilities: [capability], history });
    const first = await assistant.reply({ message: "repairs this year", context: context() });
    await assistant.reply({ message: "thanks, explain that", context: context(), conversationId: first.conversationId });
    const secondRoute = inputs(provider)[1];
    assert.equal(secondRoute.history.length, 2);
    assert.match(secondRoute.history[1].text, /not shown here/);
    assert.ok(!JSON.stringify(provider.requests.slice(1)).includes("7,431"));

    // Another user in the same tenant, and the same user id in another tenant, cannot continue it.
    const other = await assistant.reply({ message: "hello", context: context({ actor: { type: "USER", userId: "user-0002" } }), conversationId: first.conversationId });
    assert.notEqual(other.conversationId, first.conversationId);
    assert.deepEqual(inputs(provider)[3].history, []);
    assert.deepEqual(await assistant.loadConversation({ context: context({ tenantId: "tenant-0002" }), conversationId: first.conversationId }), []);
    const own = await assistant.loadConversation({ context: context(), conversationId: first.conversationId });
    assert.equal(own.length, 4);
    assert.equal(own[1].blocks[1].type, "table", "the user still sees their own data answer");
  });
});

describe("assistant: persisted conversations (folder store, across restarts)", () => {
  it("restores, continues, isolates, starts new chats and expires after the retention period", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-persist-"));
    let clock = new Date("2026-11-05T10:00:00.000Z");
    const historyOn = () => createConversationHistory({ store: createFolderConversationStore({ root }), now: () => clock });
    try {
      // First "server process": one question.
      const first = setup([route({}), answer([paragraph("Hello! I can help.")])], { history: historyOn() });
      const started = await first.assistant.reply({ message: "Hi, what can you do?", context: context() });

      // A restart (new store and assistant on the same folder), as after a deploy or a page refresh.
      clock = new Date("2026-11-05T10:05:00.000Z");
      const second = setup([route({}), answer([paragraph("Sure, here is more.")]), route({}), answer([paragraph("A new topic.")])], { history: historyOn() });
      const listed = await second.assistant.listConversations({ context: context() });
      assert.deepEqual(listed.map((row) => row.conversationId), [started.conversationId], "the latest conversation is listed for the user");
      assert.equal(listed[0].title, "Hi, what can you do?");
      assert.deepEqual((await second.assistant.loadConversation({ context: context(), conversationId: started.conversationId })).map((m) => m.text), ["Hi, what can you do?", "Hello! I can help."]);

      // Continuing keeps the id and gives the model the earlier turns.
      const continued = await second.assistant.reply({ message: "tell me more", context: context(), conversationId: started.conversationId });
      assert.equal(continued.conversationId, started.conversationId);
      assert.equal(inputs(second.provider)[0].history.length, 2);

      // New chat: no id, so a separate conversation that becomes the most recent one.
      clock = new Date("2026-11-05T10:10:00.000Z");
      const fresh = await second.assistant.reply({ message: "Another question", context: context() });
      assert.notEqual(fresh.conversationId, started.conversationId);
      assert.deepEqual(inputs(second.provider)[2].history, []);
      assert.deepEqual((await second.assistant.listConversations({ context: context() })).map((row) => row.conversationId), [fresh.conversationId, started.conversationId]);

      // Isolation by user, tenant and application.
      for (const other of [context({ actor: { type: "USER", userId: "user-0002" } }), context({ tenantId: "tenant-0002" })]) {
        assert.deepEqual(await second.assistant.listConversations({ context: other }), []);
        assert.deepEqual(await second.assistant.loadConversation({ context: other, conversationId: started.conversationId }), []);
      }
      const otherApp = createConversationHistory({ store: createFolderConversationStore({ root }), now: () => clock });
      assert.deepEqual(await otherApp.list({ context: makeContext({ applicationId: "other-app" }) }), []);

      // Nothing secret on disk: the context's grants are not stored.
      const files = [];
      const walk = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) entry.isDirectory() ? await walk(join(dir, entry.name)) : files.push(join(dir, entry.name)); };
      await walk(root);
      const disk = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
      assert.ok(!disk.includes("repairs:read") && !disk.includes("permittedTasks"), "no grants stored");

      // 14 days after the last activity both are gone: hidden at once, deleted by the cleanup job.
      clock = new Date("2026-11-19T10:11:00.000Z");
      const later = historyOn();
      assert.deepEqual(await later.list({ context: context() }), []);
      assert.deepEqual(await later.load({ context: context(), conversationId: fresh.conversationId }), []);
      assert.equal((await later.cleanupExpiredConversations()).deleted, 2);
      files.length = 0;
      await walk(root);
      assert.equal(files.length, 0, "expired conversation files are deleted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("analytics report blocks", () => {
  it("contain findings, metrics, tables and notes, never SQL or the planner's explanation", () => {
    const blocks = analyticsReportToBlocks({
      summary: "Plan to answer with SELECT count(*) FROM repairs",
      sections: [
        { title: "Total", columns: [{ name: "repairs" }], rows: [["7431"]], truncated: false, observations: [{ text: "Repairs: 7,431." }], sql: ["SELECT count(*) FROM repairs"] },
        { title: "By month", columns: [{ name: "month" }, { name: "repairs" }], rows: [["2026-10-01", "913"], ["2026-11-01", "4219"]], truncated: false, observations: [{ text: "Repairs peaked in Nov 2026." }, { text: "Up 362%." }], sql: ["SELECT ..."] },
      ],
      notes: [{ id: "n", text: "Test vehicles are excluded." }],
      unanswered: [{ part: "repairs by driver", reason: "drivers are not linked to repairs" }],
      failures: [],
    });
    const text = JSON.stringify(blocks);
    assert.ok(!/SELECT|Plan to answer/.test(text));
    assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "heading", "metrics", "heading", "table", "bullets", "notice", "notice"]);
    assert.deepEqual(blocks[2].items, [{ label: "Repairs", value: "7,431" }]);
  });
});
