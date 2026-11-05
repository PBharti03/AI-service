import assert from "node:assert/strict";
import { z } from "zod";
import { AiServiceError, defineSqlPolicy, defineTask, ErrorCodes } from "../../src/index.js";
import { createPostgresSqlValidator } from "../../src/sql/PostgresSqlValidator.js";

/** Runs the action and asserts it fails with an AiServiceError of the given code. */
export async function expectAiError(action, code) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiServiceError, `expected AiServiceError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

export function recordingLogger() {
  const entries = [];
  const at = (level) => (message, meta) => {
    entries.push({ level, message, meta });
  };
  return { entries, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}

const DEFAULT_USAGE = { promptTokens: 40, completionTokens: 12, totalTokens: 52 };

/** Scripted provider: each call consumes the next step. Records every request it receives. */
export class FakeProvider {
  info;
  requests = [];
  steps;

  constructor(steps, info = {}) {
    this.steps = [...steps];
    this.info = {
      id: "fake",
      kind: "SELF_HOSTED",
      model: "fake-model",
      modelRevision: null,
      allowedClassifications: ["SYNTHETIC", "INTERNAL", "CONFIDENTIAL"],
      structuredOutput: "json_schema",
      ...info,
    };
  }

  complete(request, options = {}) {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error("FakeProvider has no scripted step left"));
    }
    switch (step.kind) {
      case "reply":
        return Promise.resolve({
          content: step.content,
          finishReason: step.finishReason ?? "stop",
          usage: step.usage ?? DEFAULT_USAGE,
          model: this.info.model,
          latencyMs: 5,
        });
      case "fail":
        return Promise.reject(step.error);
      case "hang":
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              reject(new AiServiceError(ErrorCodes.CANCELLED, "The AI request was cancelled"));
            },
            { once: true },
          );
        });
    }
  }

  healthCheck() {
    return Promise.resolve();
  }
}

export function reply(content, finishReason = "stop") {
  return { kind: "reply", content, finishReason };
}

export function fail(error) {
  return { kind: "fail", error };
}

/** Injected fetch that records calls and answers from the handler. Never touches the network. */
export function stubFetch(handler) {
  const calls = [];
  const fetch = (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch, calls };
}

/** A fetch that never answers and rejects only when its signal aborts, like a stalled server. */
export function hangingFetch() {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        },
        { once: true },
      );
    });
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function completionBody(content, overrides = {}) {
  return {
    model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    ...overrides,
  };
}

/** Response streamed in chunks with no Content-Length header, to exercise the streaming size limit. */
export function streamedResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

export function requestBody(init) {
  if (typeof init?.body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(init.body);
}

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

/**
 * Builds a small, valid one-page PDF with the given lines of text (Helvetica), so PDF extraction can be
 * tested without binary fixtures. Byte offsets in the cross-reference table are computed exactly.
 * @param {string[]} lines
 * @returns {Uint8Array}
 */
export function minimalPdf(lines) {
  const escape = (text) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL", ...lines.map((line) => `(${escape(line)}) '`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/**
 * Synthetic lead-analytics schema for text-to-SQL tests. lead_events.email and the contacts table are
 * present in the schema but never allowed, to prove the policy (not the schema) decides access.
 */
export const syntheticSqlSchema = {
  tables: [
    {
      name: "lead_events",
      description: "One row per synthetic lead",
      columns: [
        { name: "lead_id", type: "uuid", role: "identifier" },
        {
          name: "source",
          type: "text",
          allowedValues: ["meta_lead_ads", "facebook_comments", "instagram_comments", "linkedin", "google_forms"],
        },
        { name: "platform", type: "text", allowedValues: ["Facebook", "Instagram", "LinkedIn", "Google"] },
        { name: "status", type: "text", allowedValues: ["New", "Contacted", "Won", "Lost"] },
        { name: "form_id", type: "text" },
        { name: "created_at", type: "timestamptz", role: "time" },
        { name: "created_date", type: "date", role: "time" },
        { name: "is_test", type: "boolean" },
        { name: "amount", type: "numeric", role: "measure" },
        { name: "email", type: "text" },
      ],
    },
    {
      name: "lead_forms",
      columns: [
        { name: "form_id", type: "text" },
        { name: "form_name", type: "text" },
      ],
    },
    {
      name: "contacts",
      columns: [
        { name: "email", type: "text" },
        { name: "phone", type: "text" },
      ],
    },
    {
      name: "MetaLeads",
      columns: [
        { name: "LeadStatus", type: "text" },
        { name: "CreatedAt", type: "timestamptz" },
      ],
    },
  ],
  relationships: [{ from: "lead_events.form_id", to: "lead_forms.form_id" }],
};

export const syntheticSqlPolicy = {
  allowedTables: ["lead_events", "lead_forms", "MetaLeads"],
  allowedColumns: {
    lead_events: ["lead_id", "source", "platform", "status", "form_id", "created_at", "created_date", "is_test", "amount"],
    lead_forms: ["form_id", "form_name"],
    MetaLeads: ["LeadStatus", "CreatedAt"],
  },
  maxRows: 100,
  timeoutMs: 5000,
};

export function syntheticValidator(overrides = {}) {
  const policy = defineSqlPolicy({
    dialect: "postgres",
    schema: structuredClone(syntheticSqlSchema),
    policy: { ...structuredClone(syntheticSqlPolicy), ...overrides },
  });
  return createPostgresSqlValidator(policy);
}

export async function expectAccepted(validator, sql) {
  const outcome = await validator.validate(sql);
  assert.ok(outcome.ok, `expected acceptance, got ${outcome.ok ? "" : `${outcome.code}: ${outcome.reason}`}`);
  return outcome.query;
}

export async function expectRejected(validator, sql, code) {
  const outcome = await validator.validate(sql);
  if (outcome.ok) assert.fail(`expected ${code}, but the statement was accepted`);
  assert.equal(outcome.code, code, `expected ${code}, got ${outcome.code} (${outcome.reason})`);
  return outcome.reason;
}
