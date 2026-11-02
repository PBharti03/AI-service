import { z } from "zod";
import { dataClassificationSchema, type DataClassification } from "../context/DataClassification";
import { AiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import type { GenerationSettings } from "../providers/ChatProvider";
import { summarizeZodError } from "../validation/ZodIssues";
import { taskIdSchema } from "./TaskId";

export type PostValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * One AI task. A task never has tools and never builds prompt strings from
 * data: it supplies fixed `instructions`, and the orchestrator places the
 * (minimized) input in a delimited, escaped untrusted-data block.
 */
export interface TaskDefinition<TInput extends z.ZodType, TOutput extends z.ZodType> {
  readonly id: string;
  /** Bump when the input or output contract changes. */
  readonly version: number;
  /** Bump when instructions or generation settings change, for evaluation tracking. */
  readonly promptVersion: string;
  readonly description: string;
  readonly instructions: string;
  /** Short label naming the data, for example "lead record". */
  readonly dataLabel: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly generation: GenerationSettings;
  /** Most sensitive data classification this task is approved for. */
  readonly maxClassification: DataClassification;
  /** Selects only the fields the model needs. Defaults to the whole validated input. */
  minimize?(input: z.output<TInput>): unknown;
  /** Business checks on schema-valid output, such as confidence thresholds. Failing it fails the task. */
  postValidate?(output: z.output<TOutput>, input: z.output<TInput>): PostValidationResult;
}

export interface RegisteredTask<TInput extends z.ZodType, TOutput extends z.ZodType>
  extends TaskDefinition<TInput, TOutput> {
  /** JSON Schema generated from outputSchema, sent to the provider for constrained decoding. */
  readonly outputJsonSchema: object;
}

export type AnyTask = RegisteredTask<z.ZodType, z.ZodType>;

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

const ALLOWED_KEYS = new Set([
  ...Object.keys(definitionSchema.shape),
  "inputSchema",
  "outputSchema",
  "minimize",
  "postValidate",
]);

const definedTasks = new WeakSet<object>();

/**
 * Validates and freezes a task definition. Only tasks created here can be
 * registered, so every task has passed these checks.
 */
export function defineTask<TInput extends z.ZodType, TOutput extends z.ZodType>(
  definition: TaskDefinition<TInput, TOutput>,
): RegisteredTask<TInput, TOutput> {
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

  let outputJsonSchema: object;
  try {
    // The model produces the schema's input side, so generate from "input".
    // Zod adds a top-level "$schema" dialect URI. It is metadata only, providers'
    // structured-output modes do not document it, so it is not sent.
    const generated: Record<string, unknown> = { ...z.toJSONSchema(definition.outputSchema, { io: "input" }) };
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

  const task: RegisteredTask<TInput, TOutput> = Object.freeze({
    ...definition,
    generation: Object.freeze({ ...definition.generation }),
    outputJsonSchema: deepFreeze(outputJsonSchema),
  });
  definedTasks.add(task);
  return task;
}

export function isRegisteredTask(value: unknown): value is AnyTask {
  return typeof value === "object" && value !== null && definedTasks.has(value);
}

/** Returns the JSON Schema path of the first object node without `additionalProperties: false`. */
function findNonStrictObject(node: unknown, path: string): string | undefined {
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

function isZodSchema(value: unknown): boolean {
  return value instanceof z.ZodType;
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}
