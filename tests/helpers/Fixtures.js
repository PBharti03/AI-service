import { z } from "zod";
import { defineTask } from "../../src/index.js";

/** Synthetic marker planted in inputs and outputs to detect content leaking into logs or errors. */
export const SECRET_MARKER = "SYNTHETIC-SECRET-7f3a91";

export const SAMPLE_TASK_ID = "test.note-summary";

const sampleInputSchema = z.strictObject({
  note: z.string().min(1).max(2000),
  internalReference: z.string().optional(),
});
const sampleOutputSchema = z.strictObject({
  summary: z.string().min(1).max(200),
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
});

/** Raw definition, for tests that derive task variants with a different id or hooks. */
export const sampleDefinition = {
  id: SAMPLE_TASK_ID,
  version: 1,
  promptVersion: "v1",
  description: "Synthetic summary task used by unit tests",
  instructions: "Summarise the note in one sentence and classify its sentiment.",
  dataLabel: "customer note",
  inputSchema: sampleInputSchema,
  outputSchema: sampleOutputSchema,
  generation: { temperature: 0, maxTokens: 256 },
  maxClassification: "CONFIDENTIAL",
  minimize: (input) => ({ note: input.note }),
};

export const sampleTask = defineTask(sampleDefinition);

export const VALID_OUTPUT = JSON.stringify({ summary: "Customer wants a two-bedroom flat.", sentiment: "POSITIVE" });

export function makeContext(overrides = {}) {
  return {
    applicationId: "lead-tracker",
    tenantId: "tenant-0001",
    actor: { type: "USER", userId: "user-0001" },
    requestId: "req-0001",
    permittedTasks: [SAMPLE_TASK_ID],
    dataClassification: "SYNTHETIC",
    ...overrides,
  };
}
