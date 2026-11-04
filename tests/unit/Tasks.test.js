import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { createTaskRegistry, defineTask, ErrorCodes } from "../../src/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { sampleTask } from "../helpers/Fixtures.js";

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
