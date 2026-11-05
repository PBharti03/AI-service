import { assertAuthorized, checkRequirement } from "../context/Authorization.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { EMPTY_TOKEN_USAGE } from "../usage/Usage.js";
import { checkQueryResult } from "../text-to-sql/ResultGuard.js";
import { buildSchemaContext, describePolicyRules } from "../text-to-sql/SchemaContext.js";
import { isSqlPolicy } from "../text-to-sql/SqlPolicy.js";
import { MAX_QUESTION_CHARS } from "../text-to-sql/TextToSqlTask.js";
import { defineAnalyticsCatalog, isAnalyticsCatalog } from "./AnalyticsCatalog.js";
import { ANALYTICS_PLAN_TASK, MAX_PLAN_CONVERSATION_TURNS, MAX_PLAN_QUERIES } from "./AnalyticsPlanTask.js";
import { mergeSections, observeSection } from "./ResultAnalysis.js";
import { buildResultChart } from "./ResultChart.js";

/** Upper bounds per question; an application may set lower ones, never higher. */
export const ANALYTICS_LIMITS = Object.freeze({ maxQueries: MAX_PLAN_QUERIES, maxTotalRows: 600, timeoutMs: 15_000 });

/** Why a planned query produced no section. Shown to the user; never contains values. */
const FAILURE_REASONS = {
  QUERY_LIMIT: (limits) => `Only ${String(limits.maxQueries)} queries can run for one question.`,
  TIME_LIMIT: (limits) => `The request reached its ${String(limits.timeoutMs / 1000)}-second time limit before this part ran.`,
  ROW_LIMIT: (limits) => `Together with the other parts it would return more than ${String(limits.maxTotalRows)} rows.`,
  EXECUTION_FAILED: () => "The database could not run the query for this part.",
  RESULT_TOO_LARGE: () => "The result for this part was too large to show.",
  RESULT_SHAPE_INVALID: () => "The result for this part had an unexpected shape.",
  SQL_JOIN_NOT_ALLOWED: () => "It would need to combine tables, which the safety rules do not allow.",
  SQL_FEATURE_NOT_ALLOWED: () => "It needs an SQL feature the safety rules do not allow.",
  SQL_AGGREGATION_REQUIRED: () => "It would return individual records; only statistics are allowed.",
  SQL_TABLE_NOT_ALLOWED: () => "It needs data the assistant is not allowed to read.",
  SQL_COLUMN_NOT_ALLOWED: () => "It needs data the assistant is not allowed to read.",
  SQL_LITERAL_INVALID: () => "It uses a value that is not one of the known values.",
};
const describeFailure = (code, limits) => (FAILURE_REASONS[code] ?? (() => "The query for this part did not pass the safety checks."))(limits);

class DeadlineReached extends Error {}

/** Settles with the promise, or rejects with DeadlineReached after ms. The promise itself is not cancelled. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineReached()), Math.max(0, ms));
  });
  promise.catch(() => {}); // a late failure after the deadline must not become an unhandled rejection
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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

function checkLimits(limits) {
  const merged = { ...ANALYTICS_LIMITS, ...limits };
  const within = (name, min) =>
    Number.isInteger(merged[name]) && merged[name] >= min && merged[name] <= ANALYTICS_LIMITS[name];
  if (!within("maxQueries", 1) || !within("maxTotalRows", 1) || !within("timeoutMs", 100)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Analytics limits must be positive integers within ANALYTICS_LIMITS");
  }
  return Object.freeze(merged);
}

/**
 * @typedef {Object} AnalyticsNote
 * @property {string} id
 * @property {(plan: { question: string, queries: readonly ValidatedQuery[] }) => boolean} appliesTo - Decides from the question and the validated queries (their tables and parameters), never from results.
 * @property {string} [text] - A fixed note.
 * @property {readonly string[]} [queries] - Fixed statements whose results the note is built from; validated with `validator` (default: the assistant's) and run with the same executor and limits.
 * @property {SqlValidator} [validator]
 * @property {(results: readonly { columns: readonly { name: string }[], rows: readonly (readonly unknown[])[] }[]) => string | null} [render]
 */

/**
 * Multi-query analytics over an application's own data, on top of an AiService:
 *   1. re-validates every earlier turn's SQL (a tampered conversation is refused),
 *   2. asks the model for a plan of 1-4 independent statements, given only the question, today's date,
 *      the policy-filtered schema and rules, the application's metric/dimension names and limitations,
 *   3. validates every statement with the application's SQL validator; rejected ones get one repair round,
 *   4. runs the valid statements one by one with the application's executor (which must accept only
 *      validated queries and run them read-only), within limits.maxQueries, maxTotalRows and timeoutMs,
 *   5. checks each result, lines up results that share a mergeKey, and builds charts, tables and
 *      evidence-backed observations in code.
 * Query results never reach the model. Parts that could not be answered are reported with a reason.
 *
 * @param {Object} options
 * @param {AiService} options.ai - Must have ANALYTICS_PLAN_TASK registered.
 * @param {SqlValidator} options.validator - For example createPostgresSqlValidator(policy).
 * @param {(query: ValidatedQuery) => Promise<{ columns: readonly { name: string }[], rows: readonly (readonly unknown[])[] }>} options.executor
 * @param {ReturnType<typeof defineAnalyticsCatalog> | Parameters<typeof defineAnalyticsCatalog>[0]} [options.catalog] - See defineAnalyticsCatalog; a plain object is validated the same way.
 * @param {{ permission?: string, feature?: string }} [options.requires] - Names the trusted context must grant before anything runs.
 * @param {Partial<typeof ANALYTICS_LIMITS>} [options.limits]
 * @param {readonly AnalyticsNote[]} [options.notes]
 * @param {() => string} [options.today] - YYYY-MM-DD in the application's time zone.
 * @param {(error: unknown) => string} [options.describeExecutionError] - A short code for logs (for example an SQLSTATE), never a message.
 */
export function createAnalyticsAssistant(options) {
  const candidate = options;
  if (
    typeof candidate?.ai?.runTask !== "function" ||
    typeof candidate.validator?.validate !== "function" ||
    !isSqlPolicy(candidate.validator.policy) ||
    typeof candidate.executor !== "function"
  ) {
    throw new AiServiceError(
      ErrorCodes.CONFIG_INVALID,
      "createAnalyticsAssistant needs an AiService, a validator built from defineSqlPolicy() and an executor",
    );
  }
  const { ai, validator, executor, notes = [], describeExecutionError } = options;
  const catalog = isAnalyticsCatalog(options.catalog) ? options.catalog : defineAnalyticsCatalog(options.catalog ?? {});
  const requires = checkRequirement(options.requires, "createAnalyticsAssistant");
  const limits = checkLimits(options.limits ?? {});
  const policy = validator.policy;
  const schema = buildSchemaContext(policy);
  const rules = describePolicyRules(policy);
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const metrics = catalog.metrics.map((item) => ({ ...item }));
  const dimensions = catalog.dimensions.map((item) => ({ ...item }));
  const limitations = [...catalog.limitations];
  const display = { labels: catalog.labels, valueLabels: catalog.valueLabels, locale: catalog.locale, smallSampleBelow: catalog.smallSampleBelow };
  for (const note of notes) {
    if (typeof note?.id !== "string" || typeof note.appliesTo !== "function" || (note.text === undefined && typeof note.render !== "function")) {
      throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Each analytics note needs an id, appliesTo and either text or render");
    }
  }

  /**
   * @param {{ question: string, context: TrustedContextInput, conversation?: readonly { question: string, queries: readonly string[] }[], signal?: AbortSignal }} request
   */
  async function answer(request) {
    // The consumer's own grants, checked before any model call or query (throws NOT_AUTHORIZED / FEATURE_NOT_ENABLED).
    assertAuthorized(request.context, requires);
    const started = Date.now();
    const remaining = () => limits.timeoutMs - (Date.now() - started);
    let usage = { ...EMPTY_TOKEN_USAGE, latencyMs: 0, attempts: 0 };
    let model = null;
    let containsInstructionsToAI = false;
    let repairAttempts = 0;
    const meta = () => ({ usage, model, containsInstructionsToAI, repairAttempts });
    const refused = (code, reason) => ({ ...meta(), status: "REJECTED", code, reason });

    const question = typeof request.question === "string" ? request.question.trim() : "";
    if (question === "" || question.length > MAX_QUESTION_CHARS)
      return refused("QUESTION_INVALID", `Question must be 1-${String(MAX_QUESTION_CHARS)} characters`);
    const conversation = request.conversation ?? [];
    if (conversation.length > MAX_PLAN_CONVERSATION_TURNS)
      return refused("CONVERSATION_INVALID", `At most ${String(MAX_PLAN_CONVERSATION_TURNS)} earlier turns are allowed`);
    for (const turn of conversation) {
      if (typeof turn?.question !== "string" || !Array.isArray(turn.queries) || turn.queries.length < 1 || turn.queries.length > MAX_PLAN_QUERIES)
        return refused("CONVERSATION_INVALID", "An earlier turn is malformed");
      for (const sql of turn.queries) {
        // An earlier SQL could have been edited by the client: it must still satisfy the policy.
        const check = typeof sql === "string" ? await validator.validate(sql) : null;
        if (!check?.ok) return refused("CONVERSATION_INVALID", "An earlier turn's SQL does not satisfy the policy");
      }
    }

    const input = {
      question,
      dialect: validator.dialect,
      today: today(),
      maxQueries: limits.maxQueries,
      schema,
      rules,
      metrics,
      dimensions,
      limitations,
      conversation: conversation.map((turn) => ({ question: turn.question.trim().slice(0, MAX_QUESTION_CHARS), queries: [...turn.queries] })),
      repair: null,
    };

    /** Runs the planner within the remaining time; null when the deadline passed. */
    async function plan() {
      const deadline = AbortSignal.timeout(Math.max(1, remaining()));
      const signal = request.signal === undefined ? deadline : AbortSignal.any([deadline, request.signal]);
      try {
        const result = await ai.runTask(ANALYTICS_PLAN_TASK, request.context, input, { signal });
        usage = addUsage(usage, result.usage);
        model = result.meta.model;
        containsInstructionsToAI ||= result.output.containsInstructionsToAI;
        return result.output;
      } catch (error) {
        if (deadline.aborted && !request.signal?.aborted) return null;
        throw error;
      }
    }

    const timedOut = () => ({
      ...meta(),
      status: "FAILED",
      explanation: "The question could not be planned in time.",
      summary: `The question could not be answered within the ${String(limits.timeoutMs / 1000)}-second time limit. Try a simpler question.`,
      sections: [],
      notes: [],
      unanswered: [],
      failures: [{ queryId: null, title: "Planning", code: "TIME_LIMIT", reason: describeFailure("TIME_LIMIT", limits) }],
      queries: [],
      totalRows: 0,
    });

    const first = await plan();
    if (first === null) return timedOut();
    if (first.kind === "NOT_ANALYTICS") return { ...meta(), status: "NOT_ANALYTICS", explanation: first.explanation };
    if (first.kind === "WRITE_REQUEST") return { ...meta(), status: "WRITE_REQUEST", explanation: first.explanation };

    const failures = [];
    const unanswered = [...first.unanswered];
    // Queries beyond the limit never run.
    const planned = first.queries.slice(0, limits.maxQueries).map((query) => ({ ...query, validated: null, rejection: null }));
    for (const query of first.queries.slice(limits.maxQueries)) {
      failures.push({ queryId: query.id, title: query.purpose, code: "QUERY_LIMIT", reason: describeFailure("QUERY_LIMIT", limits) });
    }

    async function validateAll(queries) {
      for (const query of queries) {
        const outcome = await validator.validate(query.sql);
        if (outcome.ok) {
          query.validated = outcome.query;
          query.rejection = null;
        } else {
          query.validated = null;
          query.rejection = { code: outcome.code, reason: outcome.reason };
        }
      }
    }
    await validateAll(planned);

    let rejected = planned.filter((query) => query.rejection !== null);
    if (rejected.length > 0 && policy.maxRepairAttempts > 0 && remaining() > 0) {
      input.repair = rejected.map((query) => ({ id: query.id, previousSql: query.sql, code: query.rejection.code, reason: query.rejection.reason }));
      repairAttempts = 1;
      const repaired = await plan();
      if (repaired !== null && repaired.kind === "PLAN") {
        for (const query of rejected) {
          const fix = repaired.queries.find((candidateQuery) => candidateQuery.id === query.id);
          if (fix === undefined) {
            query.rejection = { ...query.rejection, movedToUnanswered: true };
            continue;
          }
          Object.assign(query, { purpose: fix.purpose, sql: fix.sql, chartHint: fix.chartHint, mergeKey: fix.mergeKey });
        }
        await validateAll(rejected.filter((query) => query.rejection?.movedToUnanswered !== true));
        for (const part of repaired.unanswered) {
          if (!unanswered.some((existing) => existing.part === part.part)) unanswered.push(part);
        }
      }
      rejected = planned.filter((query) => query.rejection !== null);
    }
    for (const query of rejected) {
      // A part the repair moved to unanswered is reported there, not as a failure.
      if (query.rejection.movedToUnanswered === true && unanswered.length > 0) continue;
      failures.push({ queryId: query.id, title: query.purpose, code: query.rejection.code, reason: describeFailure(query.rejection.code, limits) });
    }

    // Run the valid queries one at a time, within the time and row budgets.
    const sections = [];
    const ran = [];
    let totalRows = 0;
    let outOfTime = false;
    const valid = planned.filter((query) => query.validated !== null);
    for (const query of valid) {
      const fail = (code) => failures.push({ queryId: query.id, title: query.purpose, code, reason: describeFailure(code, limits) });
      if (outOfTime || remaining() <= 0) {
        outOfTime = true;
        fail("TIME_LIMIT");
        continue;
      }
      let raw;
      try {
        raw = await withDeadline(Promise.resolve().then(() => executor(query.validated)), remaining());
      } catch (error) {
        if (error instanceof DeadlineReached) {
          outOfTime = true;
          fail("TIME_LIMIT");
        } else {
          failures.push({
            queryId: query.id,
            title: query.purpose,
            code: "EXECUTION_FAILED",
            reason: describeFailure("EXECUTION_FAILED", limits),
            ...(describeExecutionError ? { detail: String(describeExecutionError(error)).slice(0, 40) } : {}),
          });
        }
        continue;
      }
      const checked = checkQueryResult(raw, { maxRows: policy.maxRows, maxResultBytes: policy.maxResultBytes, maxResultColumns: policy.maxResultColumns });
      if (!checked.ok) {
        fail(checked.code);
        continue;
      }
      if (totalRows + checked.rows.length > limits.maxTotalRows) {
        fail("ROW_LIMIT");
        continue;
      }
      totalRows += checked.rows.length;
      ran.push({ id: query.id, purpose: query.purpose, sql: query.sql, fingerprint: query.validated.fingerprint });
      sections.push({
        id: query.id,
        title: query.purpose,
        queryIds: [query.id],
        mergeKey: query.mergeKey,
        chartHint: query.chartHint,
        columns: checked.columns.map((column) => ({ name: column.name })),
        rows: checked.rows,
        truncated: checked.truncated,
        sql: [query.sql],
        fingerprints: [query.validated.fingerprint],
      });
    }

    // Application notes (for example data that is excluded), decided from the plan and built in code.
    const noteTexts = [];
    const validatedQueries = valid.map((query) => query.validated);
    for (const note of notes) {
      let applies;
      try {
        applies = note.appliesTo({ question, queries: validatedQueries }) === true;
      } catch {
        applies = false;
      }
      if (!applies) continue;
      if (note.text !== undefined) {
        noteTexts.push({ id: note.id, text: String(note.text) });
        continue;
      }
      const results = [];
      let complete = true;
      for (const sql of note.queries ?? []) {
        const outcome = await (note.validator ?? validator).validate(sql);
        if (!outcome.ok || remaining() <= 0) {
          complete = false;
          break;
        }
        try {
          const raw = await withDeadline(Promise.resolve().then(() => executor(outcome.query)), remaining());
          const checked = checkQueryResult(raw, { maxRows: 50, maxResultBytes: 16_384, maxResultColumns: 8 });
          if (!checked.ok || totalRows + checked.rows.length > limits.maxTotalRows) {
            complete = false;
            break;
          }
          totalRows += checked.rows.length;
          results.push({ columns: checked.columns, rows: checked.rows });
        } catch {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      let text;
      try {
        text = note.render(results);
      } catch {
        text = null;
      }
      if (typeof text === "string" && text.trim() !== "") noteTexts.push({ id: note.id, text: text.trim().slice(0, 400) });
    }

    // Line up results that share a key, then chart and describe every section.
    const generatedAt = new Date().toISOString();
    const hints = new Map(sections.map((section) => [section.id, section.chartHint]));
    const sqlOf = new Map(sections.map((section) => [section.id, { sql: section.sql, fingerprints: section.fingerprints }]));
    const shown = mergeSections(sections).map((section) => {
      const memberIds = section.queryIds;
      const fingerprints = memberIds.flatMap((id) => sqlOf.get(id).fingerprints);
      const chartHint = hints.get(memberIds[0]) ?? "none";
      const plain = { id: section.id, title: section.title, queryIds: memberIds, columns: section.columns, rows: section.rows, truncated: section.truncated };
      return {
        ...plain,
        sql: memberIds.flatMap((id) => sqlOf.get(id).sql),
        chart: buildResultChart(plain, { chartHint, title: section.title, fingerprints, generatedAt, labels: display.labels, valueLabels: display.valueLabels }),
        initialView: chartHint === "table" ? "table" : "chart",
        observations: observeSection(plain, { ...display, today: input.today }),
      };
    });

    const status = shown.length === 0 ? "FAILED" : failures.length > 0 || unanswered.length > 0 ? "PARTIAL" : "ANSWERED";
    const headline = shown.flatMap((section) => section.observations.slice(0, 2).map((observation) => observation.text)).slice(0, 4);
    const missing =
      failures.length + unanswered.length === 0
        ? ""
        : ` ${String(failures.length + unanswered.length)} part${failures.length + unanswered.length === 1 ? "" : "s"} of the question could not be answered (see below).`;
    const explanation = first.explanation.replace(/\s+/g, " ").trim().replace(/\.?$/, ".");
    const summary = (shown.length === 0 ? `${explanation} No part of the question could be answered.${missing}` : `${explanation} ${headline.join(" ")}${missing}`).trim();

    return {
      ...meta(),
      status,
      explanation,
      summary,
      sections: shown,
      notes: noteTexts,
      unanswered,
      failures,
      queries: ran,
      totalRows,
    };
  }

  return Object.freeze({ answer, limits, policy });
}
