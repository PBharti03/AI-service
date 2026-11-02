import "../helpers/NoNetwork";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ErrorCodes } from "../../src";
import { MAX_OUTPUT_CHARS, parseStructuredOutput } from "../../src/validation/StructuredOutput";
import { expectAiError } from "../helpers/Assertions";

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
    await expectAiError(() => parseStructuredOutput('{"summary":"ok","score":2}', schema, "stop"), ErrorCodes.OUTPUT_SCHEMA_INVALID);
    await expectAiError(() => parseStructuredOutput('{"summary":"ok"}', schema, "stop"), ErrorCodes.OUTPUT_SCHEMA_INVALID);
    await expectAiError(() => parseStructuredOutput("[]", schema, "stop"), ErrorCodes.OUTPUT_SCHEMA_INVALID);
  });

  it("rejects oversized output before parsing", async () => {
    const huge = `{"summary":"${"a".repeat(MAX_OUTPUT_CHARS)}","score":0}`;
    const error = await expectAiError(() => parseStructuredOutput(huge, schema, "stop"), ErrorCodes.OUTPUT_PARSE_FAILED);
    assert.equal(error.details.reason, "too_large");
  });
});
