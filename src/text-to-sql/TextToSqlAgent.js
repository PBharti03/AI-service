import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { EMPTY_TOKEN_USAGE } from "../usage/Usage.js";
import { buildSchemaContext, describePolicyRules } from "./SchemaContext.js";
import { isSqlPolicy } from "./SqlPolicy.js";
import { MAX_CONVERSATION_TURNS, MAX_QUESTION_CHARS, TEXT_TO_SQL_TASK } from "./TextToSqlTask.js";

/**
 * An earlier turn of the same conversation: the question and the SQL the agent generated for it.
 * @typedef {Object} TextToSqlTurn
 * @property {string} question
 * @property {string} sql
 */

/**
 * @typedef {Object} TextToSqlRequest
 * @property {string} question
 * @property {TrustedContextInput} context
 * @property {readonly TextToSqlTurn[]} [conversation] - Up to MAX_CONVERSATION_TURNS earlier turns, oldest first. Each SQL is validated again before use.
 * @property {AbortSignal} [signal]
 */

/**
 * The outcome of generate(). Nothing has been executed: a VALIDATED result carries a ValidatedQuery that the application may pass to its own read-only executor.
 * @typedef {| (Common & { readonly status: "VALIDATED"; readonly query: ValidatedQuery; readonly generatedSql: string; readonly chartHint: ChartHint }) | (Common & { readonly status: "UNANSWERABLE" }) | (Common & { readonly status: "WRITE_REQUEST" }) | (Common & { readonly status: "REJECTED"; readonly code: SqlValidationCode | "CONVERSATION_INVALID" | "QUESTION_INVALID"; readonly reason: string })} TextToSqlGeneration
 */

/**
 * @typedef {Object} TextToSqlAgent
 * @property {(request: TextToSqlRequest) => Promise<TextToSqlGeneration>} generate - Generates and validates SQL for a question. Never executes it.
 */

/**
 * @typedef {Object} TextToSqlAgentOptions
 * @property {AiService} ai
 * @property {SqlValidator} validator - A dialect validator such as createPostgresSqlValidator(policy).
 * @property {() => string} [today] - Today's date as YYYY-MM-DD in the application's time zone. Defaults to the UTC date.
 */

/** An earlier turn of the same conversation: the question and the SQL the agent generated for it. */

/**
 * The outcome of generate(). Nothing has been executed: a VALIDATED result carries a ValidatedQuery that
 * the application may pass to its own read-only executor.
 */

/** Token counts are null when a provider does not report them; a sum stays null only if both are. */
function addCount(a, b) {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function addUsage(total, next) {
  return {
    promptTokens: addCount(total.promptTokens, next.promptTokens),
    completionTokens: addCount(total.completionTokens, next.completionTokens),
    totalTokens: addCount(total.totalTokens, next.totalTokens),
    latencyMs: total.latencyMs + next.latencyMs,
    attempts: total.attempts + next.attempts,
  };
}

/**
 * Text-to-SQL on top of an AiService. The application registers TEXT_TO_SQL_TASK in its task registry and
 * permits it in the trusted context; the agent then:
 *   1. re-validates every earlier turn's SQL (a tampered conversation is refused),
 *   2. asks the model for one statement, given only the policy-filtered schema and rules,
 *   3. validates and rewrites the statement with the dialect validator,
 *   4. on rejection, asks once more (maxRepairAttempts) with only the rejection code and reason.
 * The agent holds no database connection and never executes SQL.
 */
export function createTextToSqlAgent(options) {
  // Checked at runtime: options may come from untyped JavaScript.
  const candidate = options;
  if (
    typeof candidate.ai?.runTask !== "function" ||
    typeof candidate.validator?.validate !== "function" ||
    !isSqlPolicy(candidate.validator.policy)
  ) {
    throw new AiServiceError(
      ErrorCodes.CONFIG_INVALID,
      "createTextToSqlAgent needs an AiService and a validator built from defineSqlPolicy()",
    );
  }
  const { ai, validator } = options;
  const policy = validator.policy;
  const schema = buildSchemaContext(policy);
  const rules = describePolicyRules(policy);
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));

  async function generate(request) {
    let usage = { ...EMPTY_TOKEN_USAGE, latencyMs: 0, attempts: 0 };
    let model = null;
    const base = { explanation: "", containsInstructionsToAI: false, repairAttempts: 0 };
    const refused = (code, reason) => ({ ...base, usage, model, status: "REJECTED", code, reason });

    const question = typeof request.question === "string" ? request.question.trim() : "";
    if (question === "" || question.length > MAX_QUESTION_CHARS)
      return refused("QUESTION_INVALID", `Question must be 1-${String(MAX_QUESTION_CHARS)} characters`);

    const conversation = request.conversation ?? [];
    if (conversation.length > MAX_CONVERSATION_TURNS)
      return refused("CONVERSATION_INVALID", `At most ${String(MAX_CONVERSATION_TURNS)} earlier turns are allowed`);
    for (const turn of conversation) {
      // An earlier SQL could have been edited by the client: it must still satisfy the policy.
      const check = typeof turn.question === "string" && typeof turn.sql === "string" ? await validator.validate(turn.sql) : null;
      if (!check?.ok) return refused("CONVERSATION_INVALID", "An earlier turn's SQL does not satisfy the policy");
    }

    const input = {
      question,
      dialect: validator.dialect,
      today: today(),
      schema,
      rules,
      conversation: conversation.map((turn) => ({ question: turn.question.trim().slice(0, MAX_QUESTION_CHARS), sql: turn.sql })),
      repair: null,
    };
    const runOptions = request.signal === undefined ? {} : { signal: request.signal };

    for (let attempt = 0; ; attempt += 1) {
      const result = await ai.runTask(TEXT_TO_SQL_TASK, request.context, input, runOptions);
      usage = addUsage(usage, result.usage);
      model = result.meta.model;
      const output = result.output;
      const common = {
        explanation: output.explanation,
        containsInstructionsToAI: output.containsInstructionsToAI,
        usage,
        model,
        repairAttempts: attempt,
      };
      if (output.kind === "UNANSWERABLE") return { ...common, status: "UNANSWERABLE" };
      if (output.kind === "WRITE_REQUEST") return { ...common, status: "WRITE_REQUEST" };

      const outcome = await validator.validate(output.sql);
      if (outcome.ok)
        return { ...common, status: "VALIDATED", query: outcome.query, generatedSql: output.sql, chartHint: output.chartHint };
      if (attempt >= policy.maxRepairAttempts)
        return { ...common, status: "REJECTED", code: outcome.code, reason: outcome.reason };
      input.repair = { previousSql: output.sql, code: outcome.code, reason: outcome.reason };
    }
  }

  return Object.freeze({ generate });
}
