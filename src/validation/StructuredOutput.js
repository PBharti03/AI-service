import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "./ZodIssues.js";

export const MAX_OUTPUT_CHARS = 100_000;

/**
 * Fail-closed parsing of model output: only a complete ("stop") response
 * consisting of exactly one JSON document that satisfies the schema is
 * accepted. No repair, no extraction from Markdown fences, no partial results.
 */
export function parseStructuredOutput(content, schema, finishReason) {
  if (finishReason !== "stop") {
    throw new AiServiceError(ErrorCodes.OUTPUT_PARSE_FAILED, "Model output is incomplete", {
      details: { reason: finishReason === "length" ? "truncated" : "unexpected_finish" },
    });
  }
  if (content.length > MAX_OUTPUT_CHARS) {
    throw new AiServiceError(ErrorCodes.OUTPUT_PARSE_FAILED, "Model output is too large", {
      details: { reason: "too_large", limitChars: MAX_OUTPUT_CHARS },
    });
  }

  let value;
  try {
    value = JSON.parse(content);
  } catch {
    // The SyntaxError is dropped on purpose: V8 quotes the offending text in its message.
    throw new AiServiceError(ErrorCodes.OUTPUT_PARSE_FAILED, "Model output is not valid JSON", {
      details: { reason: "not_json" },
    });
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AiServiceError(ErrorCodes.OUTPUT_SCHEMA_INVALID, "Model output does not match the task schema", {
      details: summarizeZodError(result.error, schema),
    });
  }
  return result.data;
}
