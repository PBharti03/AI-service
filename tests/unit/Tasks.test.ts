import "../helpers/NoNetwork";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  createTaskRegistry,
  defineTask,
  ErrorCodes,
  intentOutputSchema,
  requireConfidentIntent,
  UNKNOWN_INTENT,
  type AnyTask,
  type TaskDefinition,
} from "../../src";
import { expectAiError } from "../helpers/Assertions";
import { sampleTask } from "../helpers/Fixtures";

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
} as const;

function definition(
  overrides: Partial<TaskDefinition<typeof inputSchema, typeof outputSchema>> = {},
): TaskDefinition<typeof inputSchema, typeof outputSchema> {
  return { ...baseFields, inputSchema, outputSchema, ...overrides };
}

describe("defineTask", () => {
  it("returns a frozen task with a generated JSON schema", () => {
    const task = defineTask(definition());
    assert.ok(Object.isFrozen(task));
    assert.ok(Object.isFrozen(task.generation));
    assert.ok(Object.isFrozen(task.outputJsonSchema));
    assert.equal((task.outputJsonSchema as { type?: unknown }).type, "object");
    assert.equal((task.outputJsonSchema as { additionalProperties?: unknown }).additionalProperties, false);
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
    await expectAiError(
      () => defineTask({ ...baseFields, inputSchema, outputSchema: z.string() }),
      ErrorCodes.CONFIG_INVALID,
    );
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
    const notZod = { safeParse: () => ({ success: true }) } as unknown as typeof outputSchema;
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
    const forged = { ...defineTask(definition()) } as AnyTask;
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

describe("intent helpers", () => {
  it("always includes UNKNOWN", () => {
    const schema = intentOutputSchema(["LATEST_ORDERS", "ORDER_STATUS"]);
    assert.equal(schema.safeParse({ intent: UNKNOWN_INTENT, confidence: 0.2, ambiguous: false }).success, true);
    assert.equal(schema.safeParse({ intent: "LATEST_ORDERS", confidence: 0.9, ambiguous: false }).success, true);
    assert.equal(schema.safeParse({ intent: "DELETE_ACCOUNT", confidence: 0.9, ambiguous: false }).success, false);
    assert.equal(schema.safeParse({ intent: "LATEST_ORDERS", confidence: 1.5, ambiguous: false }).success, false);
  });

  it("rejects invalid intent lists", async () => {
    await expectAiError(() => intentOutputSchema([]), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => intentOutputSchema(["UNKNOWN"]), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => intentOutputSchema(["A", "A"]), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => intentOutputSchema(["latest_orders"]), ErrorCodes.CONFIG_INVALID);
  });

  it("fails closed on ambiguous or low-confidence classifications", async () => {
    const gate = requireConfidentIntent(0.7);
    assert.deepEqual(gate({ confidence: 0.9, ambiguous: false }), { ok: true });
    assert.deepEqual(gate({ confidence: 0.69, ambiguous: false }), { ok: false, reason: "low_confidence" });
    assert.deepEqual(gate({ confidence: 0.99, ambiguous: true }), { ok: false, reason: "ambiguous" });
    await expectAiError(() => requireConfidentIntent(0), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => requireConfidentIntent(1.1), ErrorCodes.CONFIG_INVALID);
  });
});
