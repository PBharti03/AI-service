import "../helpers/NoNetwork";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  AiServiceError,
  createAiService,
  createTaskRegistry,
  defineTask,
  ErrorCodes,
  type AiServiceOptions,
  type ChatProvider,
  type UsageRecord,
} from "../../src";
import { expectAiError, recordingLogger } from "../helpers/Assertions";
import { FakeProvider, fail, reply, type FakeStep } from "../helpers/FakeProvider";
import { makeContext, sampleDefinition, sampleTask, VALID_OUTPUT } from "../helpers/Fixtures";

const input = { note: "Synthetic lead wants a two-bedroom flat near the metro.", internalReference: "crm-ref-001" };

function setup(steps: FakeStep[], options: Partial<AiServiceOptions> = {}, provider?: ChatProvider) {
  const fake = new FakeProvider(steps);
  const usage: UsageRecord[] = [];
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
      redact: (data) => ({ ...(data as Record<string, unknown>), note: "[redacted]" }),
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
    await expectAiError(
      () => service.runTask(sampleTask, { ...makeContext(), tenantId: "" }, input),
      ErrorCodes.CONTEXT_INVALID,
    );
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
    await expectAiError(
      () => service.runTask(sampleTask, makeContext(), { note: "" }),
      ErrorCodes.INPUT_INVALID,
    );
    await expectAiError(
      () => service.runTask(sampleTask, makeContext(), { note: "ok", tenantId: "tenant-9999" } as never),
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
    await expectAiError(
      () => createAiService({ provider: { info: { id: "x" } } as unknown as ChatProvider, registry }),
      ErrorCodes.CONFIG_INVALID,
    );
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
      postValidate: (output) => (output.sentiment === "NEGATIVE" ? { ok: false, reason: "negative_not_supported" } : { ok: true }),
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
    const schema = fake.requests[0]?.jsonSchema?.schema as { properties?: Record<string, unknown>; required?: unknown };
    assert.ok(schema.properties && "summary" in schema.properties && "sentiment" in schema.properties);
    assert.deepEqual(schema.required, ["summary", "sentiment"]);
    assert.equal(z.toJSONSchema(sampleTask.outputSchema, { io: "input" }).type, "object");
  });
});
