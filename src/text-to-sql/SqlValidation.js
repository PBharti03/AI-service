/**
 * @typedef {Object} SqlRejection
 * @property {false} ok
 * @property {SqlValidationCode} code
 * @property {string} reason - Short, safe to show to the model in a repair prompt and to log: no literal values.
 */

/**
 * @typedef {string | number | boolean | null} SqlParam
 */

/**
 * A statement that passed validation and rewriting: user-facing values are bind parameters ($1, $2, ...) and the row limit is enforced. Only this package creates one (see isValidatedQuery); executors should refuse anything else.
 * @typedef {Object} ValidatedQuery
 * @property {SqlDialect} dialect
 * @property {string} sql
 * @property {readonly SqlParam[]} params
 * @property {readonly string[]} tables - Tables and "table.column" paths the statement reads, sorted.
 * @property {readonly string[]} columns
 * @property {number} limit - The LIMIT applied (maxRows + 1 unless the query asked for fewer).
 * @property {number} maxRows
 * @property {number} timeoutMs
 * @property {string} fingerprint - sha256 of the parameterised SQL: lets logs identify a query without its text or values.
 */

/**
 * @typedef {{ readonly ok: true; readonly query: ValidatedQuery } | SqlRejection} SqlValidationOutcome
 */

/**
 * What the agent needs from a dialect validator (for example createPostgresSqlValidator).
 * @typedef {Object} SqlValidator
 * @property {SqlDialect} dialect
 * @property {SqlPolicy} policy
 * @property {(sql: string) => Promise<SqlValidationOutcome>} validate
 */

/** Why a statement or result was refused. Reasons name identifiers at most, never literal values. */
export const SqlValidationCodes = {
  SQL_EMPTY: "SQL_EMPTY",
  SQL_TOO_LONG: "SQL_TOO_LONG",
  SQL_INVALID_CHARACTERS: "SQL_INVALID_CHARACTERS",
  SQL_COMMENT_NOT_ALLOWED: "SQL_COMMENT_NOT_ALLOWED",
  SQL_PARSE_FAILED: "SQL_PARSE_FAILED",
  SQL_NOT_SINGLE_SELECT: "SQL_NOT_SINGLE_SELECT",
  SQL_TABLE_NOT_ALLOWED: "SQL_TABLE_NOT_ALLOWED",
  SQL_COLUMN_NOT_ALLOWED: "SQL_COLUMN_NOT_ALLOWED",
  SQL_FUNCTION_NOT_ALLOWED: "SQL_FUNCTION_NOT_ALLOWED",
  SQL_TYPE_NOT_ALLOWED: "SQL_TYPE_NOT_ALLOWED",
  SQL_FEATURE_NOT_ALLOWED: "SQL_FEATURE_NOT_ALLOWED",
  SQL_JOIN_NOT_ALLOWED: "SQL_JOIN_NOT_ALLOWED",
  SQL_LITERAL_INVALID: "SQL_LITERAL_INVALID",
  SQL_AGGREGATION_REQUIRED: "SQL_AGGREGATION_REQUIRED",
  SQL_LIMIT_INVALID: "SQL_LIMIT_INVALID",
  SQL_TOO_COMPLEX: "SQL_TOO_COMPLEX",
  SQL_REWRITE_FAILED: "SQL_REWRITE_FAILED",
  RESULT_SHAPE_INVALID: "RESULT_SHAPE_INVALID",
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
};

export function reject(code, reason) {
  return Object.freeze({ ok: false, code, reason: reason.slice(0, 200) });
}

/**
 * A statement that passed validation and rewriting: user-facing values are bind parameters ($1, $2, ...)
 * and the row limit is enforced. Only this package creates one (see isValidatedQuery); executors should
 * refuse anything else.
 */

/** What the agent needs from a dialect validator (for example createPostgresSqlValidator). */

const validatedQueries = new WeakSet();

export function brandValidatedQuery(query) {
  const frozen = Object.freeze({
    ...query,
    params: Object.freeze([...query.params]),
    tables: Object.freeze([...query.tables]),
    columns: Object.freeze([...query.columns]),
  });
  validatedQueries.add(frozen);
  return frozen;
}

/** True only for queries produced by a validator in this package (not for look-alike objects). */
export function isValidatedQuery(value) {
  return typeof value === "object" && value !== null && validatedQueries.has(value);
}
