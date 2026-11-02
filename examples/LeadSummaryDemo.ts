/**
 * Synthetic-data demonstration of @b2y/ai-service against Groq.
 *
 * One task (lead.summary), one synthetic lead, exactly one AI request.
 * No database, Express, BullMQ or application code. The API key is read from
 * GROQ_API_KEY and is never printed.
 *
 * Run: npm run demo:groq
 */
import { z } from "zod";
import {
  AiServiceError,
  createAiService,
  createOpenAICompatibleProvider,
  createTaskRegistry,
  defineTask,
  type UsageRecord,
} from "../src";

const SYNTHETIC_LEAD =
  "Customer: Rahul Sharma. Interested in a 2BHK apartment in Bhopal. Budget approximately ₹55 lakh. " +
  "Wants possession within 6 months. Prefers locations near schools. Has asked about parking and " +
  "maintenance charges. Has not confirmed a site visit.";

const UNKNOWN = "UNKNOWN";

const leadSummaryTask = defineTask({
  id: "lead.summary",
  version: 1,
  promptVersion: "v1",
  description: "Summarise a lead and extract requirements, budget, timeline, objections, interest and next action",
  instructions: [
    "Analyse the lead record and fill every field of the required JSON object.",
    "Use only facts stated in the lead record. Never invent names, amounts, dates, locations or preferences.",
    `If a fact is not stated, use "${UNKNOWN}" for text fields and list what is missing in missingInformation.`,
    "Questions the customer asked or concerns they raised count as objections only if they could delay or block the sale.",
    "interestLevel is HIGH, MEDIUM or LOW only when the record supports it; otherwise UNKNOWN.",
    "recommendedNextAction must be one concrete, short action for the sales team.",
    "Write in plain English. Do not include Markdown, links or contact details.",
  ].join("\n"),
  dataLabel: "lead record",
  inputSchema: z.strictObject({ leadText: z.string().min(1).max(4000) }),
  outputSchema: z.strictObject({
    summary: z.string().min(1).max(600).describe("Two or three factual sentences"),
    requirements: z.array(z.string().min(1).max(200)).max(10).describe("Stated requirements and preferences"),
    budget: z.string().min(1).max(100).describe(`Budget as stated, or ${UNKNOWN}`),
    timeline: z.string().min(1).max(100).describe(`Purchase or possession timeline as stated, or ${UNKNOWN}`),
    objections: z.array(z.string().min(1).max(200)).max(10).describe("Concerns that could delay or block the sale"),
    interestLevel: z.enum(["HIGH", "MEDIUM", "LOW", UNKNOWN]),
    recommendedNextAction: z.string().min(1).max(300),
    missingInformation: z.array(z.string().min(1).max(200)).max(10).describe("Important facts not stated in the lead"),
  }),
  generation: { temperature: 0.2, maxTokens: 1024 },
  maxClassification: "SYNTHETIC",
});

/** Metadata read from Groq's response for this report. Content is not taken from here. */
interface ObservedResponse {
  status?: number;
  model?: string;
  finishReason?: string;
  reasoningTokens?: number;
  errorType?: string;
  errorCode?: string;
  /** Groq's error message, whitespace-collapsed and truncated. Synthetic run only. */
  errorMessage?: string;
  /** Diagnosis of Groq's failed_generation without printing it: size, completeness, violated schema paths. */
  failedGeneration?: { chars: number; completeJson: boolean; schemaIssues: string };
}

function observingFetch(observed: ObservedResponse): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    observed.status = response.status;
    try {
      const body = (await response.clone().json()) as {
        model?: unknown;
        choices?: { finish_reason?: unknown }[];
        usage?: { completion_tokens_details?: { reasoning_tokens?: unknown } };
        error?: { type?: unknown; code?: unknown; message?: unknown; failed_generation?: unknown };
      };
      if (typeof body.model === "string") observed.model = body.model;
      const finish = body.choices?.[0]?.finish_reason;
      if (typeof finish === "string") observed.finishReason = finish;
      const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoning === "number") observed.reasoningTokens = reasoning;
      // Groq's error type and code, plus a short message for diagnosis. This is acceptable only
      // because the demo sends synthetic data; the package itself never surfaces provider messages.
      if (typeof body.error?.type === "string") observed.errorType = body.error.type;
      if (typeof body.error?.code === "string") observed.errorCode = body.error.code;
      if (typeof body.error?.message === "string") {
        observed.errorMessage = body.error.message.replace(/\s+/g, " ").slice(0, 240);
      }
      if (typeof body.error?.failed_generation === "string") {
        observed.failedGeneration = diagnoseFailedGeneration(body.error.failed_generation);
      }
    } catch {
      // A non-JSON body leaves the observation empty; the adapter reports the error itself.
    }
    return response;
  };
}

/** Reports whether the rejected generation was complete JSON and which schema paths it broke, never its text. */
function diagnoseFailedGeneration(text: string): { chars: number; completeJson: boolean; schemaIssues: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { chars: text.length, completeJson: false, schemaIssues: "not checked (incomplete JSON)" };
  }
  const result = leadSummaryTask.outputSchema.safeParse(value);
  const schemaIssues = result.success
    ? "none"
    : result.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"}:${issue.code}`)
        .join(", ");
  return { chars: text.length, completeJson: true, schemaIssues };
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const apiKey = process.env.GROQ_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    process.stderr.write("GROQ_API_KEY is not set. Export it, then run: npm run demo:groq\n");
    return 1;
  }

  const observed: ObservedResponse = {};
  const usageRecords: UsageRecord[] = [];

  const provider = createOpenAICompatibleProvider(
    {
      id: "groq",
      kind: "PAID",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-20b",
      apiKey: apiKey.trim(),
      timeoutMs: 60_000,
      allowedClassifications: ["SYNTHETIC"],
      structuredOutput: "json_schema",
    },
    { fetch: observingFetch(observed) },
  );

  const ai = createAiService({
    provider,
    registry: createTaskRegistry([leadSummaryTask]),
    allowPaidProvider: true,
    retry: { maxRetries: 0 },
    onUsage: (record) => {
      usageRecords.push(record);
    },
  });

  const context = {
    applicationId: "ai-service-demo",
    tenantId: "demo-tenant",
    actor: { type: "SYSTEM", userId: "demo-script" },
    requestId: `demo-${String(Date.now())}`,
    permittedTasks: ["lead.summary"],
    dataClassification: "SYNTHETIC",
  } as const;

  print("== @b2y/ai-service synthetic lead demo (Groq) ==");
  print(`provider: ${ai.providerInfo.id} (${ai.providerInfo.kind}), model: ${ai.providerInfo.model}`);
  print("data classification: SYNTHETIC; AI requests: 1; retries: 0");

  try {
    const result = await ai.runTask(leadSummaryTask, context, { leadText: SYNTHETIC_LEAD });
    print(`HTTP status: ${String(observed.status)}`);
    print(`model (from response): ${observed.model ?? "not reported"}`);
    print(`finish reason: ${observed.finishReason ?? "not reported"}`);
    print("Zod validation: passed (strict schema)");
    print(
      `tokens: prompt=${String(result.usage.promptTokens)} completion=${String(result.usage.completionTokens)} ` +
        `total=${String(result.usage.totalTokens)}` +
        (observed.reasoningTokens === undefined ? "" : ` (reasoning=${String(observed.reasoningTokens)})`),
    );
    print(`latency: ${String(Math.round(result.usage.latencyMs))} ms, attempts: ${String(result.usage.attempts)}`);
    print(`usage records: ${String(usageRecords.length)} (${usageRecords[0]?.outcome ?? "none"})`);
    print("structured output:");
    print(JSON.stringify(result.output, null, 2));
    return 0;
  } catch (error) {
    print(`HTTP status: ${String(observed.status ?? "no response")}`);
    if (observed.errorType !== undefined || observed.errorCode !== undefined) {
      print(`Groq error: type=${observed.errorType ?? "-"} code=${observed.errorCode ?? "-"}`);
    }
    if (observed.errorMessage !== undefined) {
      print(`Groq message: ${observed.errorMessage}`);
    }
    if (observed.failedGeneration !== undefined) {
      const failed = observed.failedGeneration;
      print(
        `failed_generation: ${String(failed.chars)} chars, complete JSON=${String(failed.completeJson)}, ` +
          `schema issues: ${failed.schemaIssues}`,
      );
    }
    if (error instanceof AiServiceError) {
      print(`FAILED: ${error.code} (retryable=${String(error.retryable)}) ${JSON.stringify(error.details)}`);
    } else {
      print("FAILED: unexpected error");
    }
    print(`usage records: ${String(usageRecords.length)} (${usageRecords[0]?.outcome ?? "none"})`);
    return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
