// Every fixed set of allowed values in @b2y/ai-service (dependency-free, so the UI can import it too).

// ── Context ──────────────────────────────────────────────────────────────────

/** Who an AI request runs for. */
export const ACTOR_TYPE = Object.freeze({ USER: "USER", SYSTEM: "SYSTEM" });
export const ACTOR_TYPES = Object.freeze(Object.values(ACTOR_TYPE));

/** Data sensitivity, ordered from least to most sensitive. */
export const DATA_CLASSIFICATION = Object.freeze({ SYNTHETIC: "SYNTHETIC", INTERNAL: "INTERNAL", CONFIDENTIAL: "CONFIDENTIAL", RESTRICTED: "RESTRICTED" });
export const DATA_CLASSIFICATIONS = Object.values(DATA_CLASSIFICATION);

// ── Providers ────────────────────────────────────────────────────────────────

/** Provider kinds the package can talk to. */
export const PROVIDER_TYPE = Object.freeze({ GROQ: "groq", OPENAI_COMPATIBLE: "openai-compatible" });
export const PROVIDER_TYPES = Object.freeze(Object.values(PROVIDER_TYPE));

// ── HTTP responses (B2Y shape { status, message, data }) ──────────────────────

export const RESPONSE_STATUS = Object.freeze({ SUCCESS: "SUCCESS", FAILURE: "FAILURE" });

// ── AI tasks ─────────────────────────────────────────────────────────────────

export const ASSISTANT_ROUTE_TASK_ID = "assistant.route";
export const ASSISTANT_RESPOND_TASK_ID = "assistant.respond";
export const ANALYTICS_PLAN_TASK_ID = "analytics.plan";
export const SEARCH_FILTERS_TASK_ID = "search.filters";
export const DOCUMENT_ANSWER_TASK_ID = "documents.answer";

// ── Assistant ────────────────────────────────────────────────────────────────

/** Routes the assistant has besides the application's capabilities. */
export const BUILT_IN_ROUTES = Object.freeze(["general", "unsupported"]);

/** Capability kinds. "content": generated output such as a flowchart (model-visible later, unlike data results). */
export const CAPABILITY_KINDS = Object.freeze(["data", "analytics", "search", "documents", "knowledge", "calculation", "content"]);

/** Field types a search capability can filter on. */
export const SEARCH_FIELD_TYPES = ["text", "number", "boolean", "enum"];

// ── Documents ────────────────────────────────────────────────────────────────

/**
 * Neutral kinds of document used when the consumer does not pass documentTypes. A consumer normally
 * passes its own list (lower-case names, at most 20 characters each). Only addDocument checks it:
 * documents stored earlier keep their type.
 */
export const DEFAULT_DOCUMENT_TYPES = Object.freeze(["document", "guide", "reference", "other"]);

// ── Analytics and charts ─────────────────────────────────────────────────────

export const CHART_HINTS = ["none", "table", "bar", "horizontal_bar", "stacked_bar", "line", "area", "pie", "doughnut"];
/** Every chart type a spec may name; the UI can switch between compatible ones without a new query. */
export const CHART_TYPES = ["bar", "horizontal_bar", "stacked_bar", "line", "area", "pie", "doughnut"];

// ── SQL ──────────────────────────────────────────────────────────────────────

/** SQL dialects with a validator. Only PostgreSQL for now. */
export const SQL_DIALECTS = ["postgres"];
export const SQL_COLUMN_TYPES = ["text", "integer", "numeric", "boolean", "date", "timestamp", "timestamptz", "uuid"];
/** Aggregate functions. count(*) is always allowed when count is. */
export const SQL_AGGREGATE_FUNCTIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);
/**
 * Every function a policy may allow: a curated list of side-effect-free functions. An application can
 * narrow it (allowedFunctions) but never add to it, so a misconfigured policy cannot enable pg_read_file,
 * dblink, set_config or similar. Names are matched lower-case after parsing.
 */
export const SQL_SAFE_FUNCTIONS = Object.freeze([
  ...SQL_AGGREGATE_FUNCTIONS,
  "round",
  "floor",
  "ceil",
  "ceiling",
  "abs",
  "date_trunc",
  "date_part",
  "extract",
  "to_char",
  "make_date",
  "make_interval",
  "now",
  "timezone",
  "lower",
  "upper",
  "length",
  "btrim",
  "ltrim",
  "rtrim",
]);
/** Window functions, usable only with allowWindowFunctions (aggregates may then also take OVER). */
export const SQL_SAFE_WINDOW_FUNCTIONS = Object.freeze(["row_number", "rank", "dense_rank", "lag", "lead"]);
