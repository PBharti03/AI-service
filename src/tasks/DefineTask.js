import { z } from "zod";
import { dataClassificationSchema } from "../context/DataClassification.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { taskIdSchema } from "./TaskId.js";

/**
 * @typedef {{ readonly ok: true } | { readonly ok: false; readonly reason: string }} PostValidationResult
 */

/**
 * One AI task. A task never has tools and never builds prompt strings from data: it supplies fixed `instructions`, and the orchestrator places the (minimized) input in a delimited, escaped untrusted-data block.
 * @template TInput
 * @template TOutput
 * @typedef {Object} TaskDefinition
 * @property {string} id
 * @property {number} version - Bump when the input or output contract changes.
 * @property {string} promptVersion - Bump when instructions or generation settings change, for evaluation tracking.
 * @property {string} description
 * @property {string} instructions
 * @property {string} dataLabel - Short label naming the data, for example "support ticket".
 * @property {TInput} inputSchema
 * @property {TOutput} outputSchema
 * @property {GenerationSettings} generation
 * @property {DataClassification} maxClassification - Most sensitive data classification this task is approved for.
 * @property {(input: z.output<TInput>) => unknown} [minimize] - Selects only the fields the model needs. Defaults to the whole validated input.
 * @property {(output: z.output<TOutput>, input: z.output<TInput>) => PostValidationResult} [postValidate] - Business checks on schema-valid output, such as confidence thresholds. Failing it fails the task.
 */

/**
 * @template TInput
 * @template TOutput
 * Also has every field of TaskDefinition<TInput, TOutput>.
 * @typedef {Object} RegisteredTask
 * @property {object} outputJsonSchema - JSON Schema generated from outputSchema, sent to the provider for constrained decoding.
 */

/**
 * @typedef {RegisteredTask<z.ZodType, z.ZodType>} AnyTask
 */

/**
 * One AI task. A task never has tools and never builds prompt strings from
 * data: it supplies fixed `instructions`, and the orchestrator places the
 * (minimized) input in a delimited, escaped untrusted-data block.
 */

const definitionSchema = z.object({
  id: taskIdSchema,
  version: z.number().int().min(1).max(10_000),
  promptVersion: z.string().regex(/^v\d+(\.\d+){0,2}$/),
  description: z.string().min(1).max(500),
  instructions: z.string().trim().min(1).max(8000),
  dataLabel: z.string().regex(/^[a-z][a-z ]{0,39}$/),
  generation: z.strictObject({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(32_768),
    topP: z.number().gt(0).max(1).optional(),
    seed: z.number().int().optional(),
  }),
  maxClassification: dataClassificationSchema,
});

const ALLOWED_KEYS = new Set([...Object.keys(definitionSchema.shape), "inputSchema", "outputSchema", "minimize", "postValidate"]);

const definedTasks = new WeakSet();

/**
 * Validates and freezes a task definition. Only tasks created here can be
 * registered, so every task has passed these checks.
 */
export function defineTask(definition) {
  // Unknown keys are refused rather than ignored, so a definition such as
  // `{ tools: [...] }` fails loudly instead of appearing to configure tools.
  const unknownKey = Object.keys(definition).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task definition has an unsupported field", {
      details: { field: unknownKey.slice(0, 64) },
    });
  }
  const checked = definitionSchema.safeParse(definition);
  if (!checked.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task definition is invalid", {
      details: summarizeZodError(checked.error, definitionSchema),
    });
  }
  if (!isZodSchema(definition.inputSchema) || !isZodSchema(definition.outputSchema)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task schemas must be Zod schemas", {
      details: { taskId: definition.id },
    });
  }

  let outputJsonSchema;
  try {
    // The model produces the schema's input side, so generate from "input".
    // Zod adds a top-level "$schema" dialect URI. It is metadata only, providers'
    // structured-output modes do not document it, so it is not sent.
    const generated = { ...z.toJSONSchema(definition.outputSchema, { io: "input" }) };
    outputJsonSchema = Object.fromEntries(Object.entries(generated).filter(([keyword]) => keyword !== "$schema"));
  } catch (error) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task output schema cannot be expressed as JSON Schema", {
      details: { taskId: definition.id },
      cause: error,
    });
  }
  if (!("type" in outputJsonSchema) || outputJsonSchema.type !== "object") {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task output schema must describe a JSON object", {
      details: { taskId: definition.id },
    });
  }
  // Every object in the output must be strict (z.strictObject). A plain
  // z.object would silently strip unexpected keys instead of rejecting them,
  // and its JSON Schema would not tell the model that extra keys are invalid.
  // The schema is refused rather than rewritten, so task schemas never change
  // behind the author's back.
  const looseObjectPath = findNonStrictObject(outputJsonSchema, "(root)");
  if (looseObjectPath !== undefined) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Task output objects must be strict (use z.strictObject)", {
      details: { taskId: definition.id, schemaPath: looseObjectPath.slice(0, 200) },
    });
  }

  const task = Object.freeze({
    ...definition,
    generation: Object.freeze({ ...definition.generation }),
    outputJsonSchema: deepFreeze(outputJsonSchema),
  });
  definedTasks.add(task);
  return task;
}

export function isRegisteredTask(value) {
  return typeof value === "object" && value !== null && definedTasks.has(value);
}

/** Returns the JSON Schema path of the first object node without `additionalProperties: false`. */
function findNonStrictObject(node, path) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const found = findNonStrictObject(item, `${path}.${String(index)}`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const isObjectSchema =
    ("type" in node && (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")))) ||
    "properties" in node;
  if (isObjectSchema && (!("additionalProperties" in node) || node.additionalProperties !== false)) {
    return path;
  }
  for (const [keyword, value] of Object.entries(node)) {
    const found = findNonStrictObject(value, `${path}.${keyword}`);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function isZodSchema(value) {
  return value instanceof z.ZodType;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}
