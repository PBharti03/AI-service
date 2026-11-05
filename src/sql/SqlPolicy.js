import { z } from "zod";
import { AiServiceError, ErrorCodes, summarizeZodError } from "../core/Errors.js";

/**
 * @typedef {Object} SqlColumnInfo
 * @property {string} table
 * @property {string} name
 * @property {SqlColumnType} type
 * @property {readonly string[] | null} allowedValues
 */

/**
 * A schema and policy checked against each other, frozen. Only defineSqlPolicy() creates one.
 * @typedef {Object} SqlPolicy
 * @property {SqlDialect} dialect
 * @property {SqlSchema} schema
 * @property {ReadonlyMap<string, ReadonlyMap<string, SqlColumnInfo>>} tables
 * @property {ReadonlySet<string>} functions
 * @property {ReadonlySet<string>} aggregates
 * @property {ReadonlySet<string>} relationships - Unordered "a.x=b.y" keys for declared relationships.
 * @property {"none" | "declared"} allowJoins
 * @property {boolean} allowSubqueries
 * @property {boolean} allowSetOperations
 * @property {boolean} allowWindowFunctions
 * @property {boolean} requireAggregation
 * @property {number} maxRows
 * @property {number} timeoutMs
 * @property {number} maxSqlChars
 * @property {number} maxSchemaChars
 * @property {number} maxRepairAttempts
 * @property {number} maxResultBytes
 * @property {number} maxResultColumns
 * @property {number} maxLiteralChars
 * @property {number} maxOffset
 * @property {number} maxAstNodes
 * @property {number} maxAstDepth
 */

/** SQL dialects with a validator. Only PostgreSQL for now. */
export const SQL_DIALECTS = ["postgres"];

export const SQL_COLUMN_TYPES = ["text", "integer", "numeric", "boolean", "date", "timestamp", "timestamptz", "uuid"];

/** Aggregate functions. count(*) is always allowed when count is. */
export const SQL_AGGREGATE_FUNCTIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);

/**
 * Every function a policy may allow. It is a curated list of side-effect-free functions: an application
 * can narrow it (allowedFunctions) but never add to it, so a misconfigured policy cannot enable
 * pg_read_file, dblink, set_config or similar. Names are matched lower-case after parsing.
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

/** Unquoted or quoted identifier as written in SQL (mixed case must be double-quoted in queries). */
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "must be a plain SQL identifier");
const columnPathSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$/, "must be table.column");

export const sqlSchemaSchema = z.strictObject({
  tables: z
    .array(
      z.strictObject({
        name: identifierSchema,
        description: z.string().min(1).max(500).optional(),
        columns: z
          .array(
            z.strictObject({
              name: identifierSchema,
              type: z.enum(SQL_COLUMN_TYPES),
              description: z.string().min(1).max(300).optional(),
              /** Exact values a filter on this column may use. Supplied by the application, never sampled. */
              allowedValues: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
              role: z.enum(["dimension", "measure", "time", "identifier"]).optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .min(1)
    .max(50),
  relationships: z
    .array(z.strictObject({ from: columnPathSchema, to: columnPathSchema }))
    .max(50)
    .default([]),
});

export const sqlPolicySchema = z.strictObject({
  allowedTables: z.array(identifierSchema).min(1).max(50),
  /** Per table, the columns queries may reference anywhere (select, filter, group, order, join). */
  allowedColumns: z.record(identifierSchema, z.array(identifierSchema).min(1).max(200)),
  /** Subset of SQL_SAFE_FUNCTIONS (and SQL_SAFE_WINDOW_FUNCTIONS). Defaults to all of SQL_SAFE_FUNCTIONS. */
  allowedFunctions: z
    .array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/))
    .max(100)
    .optional(),
  /** "declared": only JOIN ... ON equality over schema.relationships. "none": single-table queries. */
  allowJoins: z.enum(["none", "declared"]).default("declared"),
  allowSubqueries: z.boolean().default(true),
  allowSetOperations: z.boolean().default(false),
  allowWindowFunctions: z.boolean().default(false),
  /** Every output column must be an aggregate or a GROUP BY key (no row-level results). */
  requireAggregation: z.boolean().default(false),
  /** Hard row cap. The query is limited to maxRows + 1 rows so truncation can be detected. */
  maxRows: z.number().int().min(1).max(10_000),
  /** Passed to the application's executor, which must enforce it in the database. */
  timeoutMs: z.number().int().min(100).max(120_000),
  maxSqlChars: z.number().int().min(100).max(20_000).default(4000),
  /** Cap on the schema description sent to the model (see buildSchemaContext). */
  maxSchemaChars: z.number().int().min(500).max(100_000).default(16_000),
  /** Regenerations after a validation rejection, shown only the rejection code and reason. */
  maxRepairAttempts: z.number().int().min(0).max(1).default(1),
  maxResultBytes: z
    .number()
    .int()
    .min(1024)
    .max(10_000_000)
    .default(256 * 1024),
  maxResultColumns: z.number().int().min(1).max(200).default(50),
  maxLiteralChars: z.number().int().min(1).max(1000).default(200),
  maxOffset: z.number().int().min(0).max(1_000_000).default(10_000),
  /** Bounds on parse-tree size and nesting, against pathological queries. */
  maxAstNodes: z.number().int().min(50).max(50_000).default(3000),
  maxAstDepth: z.number().int().min(10).max(500).default(100),
});

/** A schema and policy checked against each other, frozen. Only defineSqlPolicy() creates one. */

const definedPolicies = new WeakSet();

export function isSqlPolicy(value) {
  return typeof value === "object" && value !== null && definedPolicies.has(value);
}

export function relationshipKey(a, b) {
  return a < b ? `${a}=${b}` : `${b}=${a}`;
}

function configError(message, detail) {
  return new AiServiceError(
    ErrorCodes.CONFIG_INVALID,
    message,
    detail === undefined ? {} : { details: { reason: detail.slice(0, 120) } },
  );
}

/**
 * Validates the schema the model may see and the policy queries must satisfy, and checks them against
 * each other: every allowed table and column must exist in the schema, every allowed function must be in
 * the curated safe list, and every declared relationship must join allowed columns. Throws
 * AiServiceError(CONFIG_INVALID) on any mismatch.
 */
export function defineSqlPolicy(input) {
  if (!SQL_DIALECTS.includes(input.dialect)) throw configError("Unsupported SQL dialect");
  const schemaResult = sqlSchemaSchema.safeParse(input.schema);
  if (!schemaResult.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "SQL schema is invalid", {
      details: summarizeZodError(schemaResult.error, sqlSchemaSchema),
    });
  }
  const policyResult = sqlPolicySchema.safeParse(input.policy);
  if (!policyResult.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "SQL policy is invalid", {
      details: summarizeZodError(policyResult.error, sqlPolicySchema),
    });
  }
  const schema = schemaResult.data;
  const policy = policyResult.data;

  const schemaTables = new Map(schema.tables.map((table) => [table.name, table]));
  if (schemaTables.size !== schema.tables.length) throw configError("SQL schema lists a table twice");

  const tables = new Map();
  for (const tableName of policy.allowedTables) {
    const table = schemaTables.get(tableName);
    if (table === undefined) throw configError("An allowed table is not in the schema", tableName);
    const allowed = policy.allowedColumns[tableName];
    if (allowed === undefined) throw configError("An allowed table has no allowed columns", tableName);
    const columns = new Map();
    for (const columnName of allowed) {
      const column = table.columns.find((candidate) => candidate.name === columnName);
      if (column === undefined) throw configError("An allowed column is not in the schema", `${tableName}.${columnName}`);
      columns.set(
        columnName,
        Object.freeze({
          table: tableName,
          name: columnName,
          type: column.type,
          allowedValues: column.allowedValues ? Object.freeze([...column.allowedValues]) : null,
        }),
      );
    }
    tables.set(tableName, columns);
  }
  for (const tableName of Object.keys(policy.allowedColumns)) {
    if (!tables.has(tableName)) throw configError("Allowed columns are listed for a table that is not allowed", tableName);
  }

  const safe = new Set([...SQL_SAFE_FUNCTIONS, ...(policy.allowWindowFunctions ? SQL_SAFE_WINDOW_FUNCTIONS : [])]);
  const functions = new Set(policy.allowedFunctions ?? SQL_SAFE_FUNCTIONS);
  for (const name of functions) {
    if (!safe.has(name)) throw configError("An allowed function is not in the safe function list", name);
  }

  const relationships = new Set();
  for (const { from, to } of schema.relationships) {
    for (const path of [from, to]) {
      const [table = "", column = ""] = path.split(".");
      if (tables.get(table)?.has(column) !== true) throw configError("A relationship uses a column that is not allowed", path);
    }
    relationships.add(relationshipKey(from, to));
  }

  const result = Object.freeze({
    dialect: input.dialect,
    schema,
    tables,
    functions,
    aggregates: new Set(SQL_AGGREGATE_FUNCTIONS.filter((name) => functions.has(name))),
    relationships,
    allowJoins: policy.allowJoins,
    allowSubqueries: policy.allowSubqueries,
    allowSetOperations: policy.allowSetOperations,
    allowWindowFunctions: policy.allowWindowFunctions,
    requireAggregation: policy.requireAggregation,
    maxRows: policy.maxRows,
    timeoutMs: policy.timeoutMs,
    maxSqlChars: policy.maxSqlChars,
    maxSchemaChars: policy.maxSchemaChars,
    maxRepairAttempts: policy.maxRepairAttempts,
    maxResultBytes: policy.maxResultBytes,
    maxResultColumns: policy.maxResultColumns,
    maxLiteralChars: policy.maxLiteralChars,
    maxOffset: policy.maxOffset,
    maxAstNodes: policy.maxAstNodes,
    maxAstDepth: policy.maxAstDepth,
  });
  definedPolicies.add(result);
  return result;
}

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

const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** How a name must be written in PostgreSQL: bare when lower-case, double-quoted otherwise. */
export function sqlIdentifier(name) {
  return PLAIN_IDENTIFIER.test(name) ? name : `"${name}"`;
}

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The only description of the database the model receives, built from the policy rather than the full
 * schema: tables and columns that are not allowed are never mentioned, so the model cannot learn they
 * exist. It lists, per allowed table, each allowed column with its type, role, description and allowed
 * values, then the declared join keys. Output is deterministic (schema order). Throws CONFIG_INVALID when
 * it exceeds the policy's maxSchemaChars, so oversized schemas fail at setup rather than per request.
 */
export function buildSchemaContext(policy) {
  const lines = [];
  for (const table of policy.schema.tables) {
    const allowed = policy.tables.get(table.name);
    if (allowed === undefined) continue;
    lines.push(`TABLE ${sqlIdentifier(table.name)}${table.description === undefined ? "" : ` (${oneLine(table.description)})`}`);
    for (const column of table.columns) {
      if (!allowed.has(column.name)) continue;
      const notes = [column.type];
      if (column.role !== undefined) notes.push(column.role);
      if (column.description !== undefined) notes.push(oneLine(column.description));
      if (column.allowedValues !== undefined)
        notes.push(`values: ${column.allowedValues.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ")}`);
      lines.push(`  ${sqlIdentifier(column.name)}: ${notes.join("; ")}`);
    }
  }
  const joins = policy.schema.relationships.map(({ from, to }) => {
    const [fromTable = "", fromColumn = ""] = from.split(".");
    const [toTable = "", toColumn = ""] = to.split(".");
    return `  ${sqlIdentifier(fromTable)}.${sqlIdentifier(fromColumn)} = ${sqlIdentifier(toTable)}.${sqlIdentifier(toColumn)}`;
  });
  if (joins.length > 0 && policy.allowJoins === "declared") lines.push("JOINS (the only allowed join conditions)", ...joins);

  const context = lines.join("\n");
  if (context.length > policy.maxSchemaChars) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Schema context exceeds maxSchemaChars", {
      details: { chars: context.length, limit: policy.maxSchemaChars },
    });
  }
  return context;
}

/** The policy rules the model is told about (the validator enforces them regardless). */
export function describePolicyRules(policy) {
  const rules = [
    `Return at most ${String(policy.maxRows)} rows.`,
    `Allowed functions: ${[...policy.functions].sort().join(", ")}; plus CURRENT_DATE, CURRENT_TIMESTAMP, CASE, COALESCE, NULLIF, GREATEST, LEAST, EXTRACT and AT TIME ZONE.`,
    policy.allowJoins === "declared"
      ? "Joins: only JOIN ... ON with the listed join conditions."
      : "Joins: not allowed; query one table.",
    policy.allowSubqueries ? "Subqueries and WITH are allowed." : "Subqueries and WITH are not allowed.",
    policy.allowSetOperations ? "UNION, INTERSECT and EXCEPT are allowed." : "UNION, INTERSECT and EXCEPT are not allowed.",
    policy.allowWindowFunctions ? "Window functions are allowed." : "Window functions (OVER) are not allowed.",
  ];
  if (policy.requireAggregation)
    rules.push("Every output column must be an aggregate or a GROUP BY key: never return individual rows.");
  return rules;
}

/**
 * @typedef {string | number | boolean | null} SqlCell
 */

/**
 * @typedef {Object} ExecutorColumn
 * @property {string} name
 * @property {string} [type]
 */

/**
 * What an application's executor returns: column names and rows as arrays in column order.
 * @typedef {Object} ExecutorResult
 * @property {readonly ExecutorColumn[]} columns
 * @property {readonly (readonly unknown[])[]} rows
 */

/**
 * @typedef {Object} CheckedResult
 * @property {true} ok
 * @property {readonly ExecutorColumn[]} columns
 * @property {readonly (readonly SqlCell[])[]} rows
 * @property {boolean} truncated - True when the database returned more than maxRows rows (only maxRows are kept).
 */

/**
 * @typedef {Object} ResultLimits
 * @property {number} maxRows
 * @property {number} maxResultBytes
 * @property {number} maxResultColumns
 */

/** What an application's executor returns: column names and rows as arrays in column order. */

function isColumnName(name) {
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) < 32) return false;
  }
  return name.length > 0 && name.length <= 128;
}

/**
 * Normalises one value from a database driver. Only scalars survive: bigint becomes a string and a Date an
 * ISO string; objects, arrays and buffers are refused because an aggregate query never needs them.
 */
function toCell(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return undefined;
}

/**
 * Checks what the application's executor returned before anything is shown or summarised: the declared
 * shape, scalar values only, at most maxResultColumns columns, at most maxRows rows (one extra row means
 * the result was truncated) and at most maxResultBytes of JSON.
 */
export function checkQueryResult(result, limits) {
  const candidate = result;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !Array.isArray(candidate.columns) ||
    !Array.isArray(candidate.rows)
  ) {
    return reject(SqlValidationCodes.RESULT_SHAPE_INVALID, "Executor result must have columns and rows arrays");
  }
  const columns = [];
  for (const column of candidate.columns) {
    const entry = column;
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || !isColumnName(entry.name)) {
      return reject(SqlValidationCodes.RESULT_SHAPE_INVALID, "Executor result has an invalid column");
    }
    columns.push(
      Object.freeze(entry.type === undefined ? { name: entry.name } : { name: entry.name, type: entry.type.slice(0, 64) }),
    );
  }
  if (columns.length === 0) return reject(SqlValidationCodes.RESULT_SHAPE_INVALID, "Executor result has no columns");
  if (columns.length > limits.maxResultColumns)
    return reject(SqlValidationCodes.RESULT_TOO_LARGE, `Result has more than ${String(limits.maxResultColumns)} columns`);

  const sourceRows = candidate.rows;
  // The query asks for maxRows + 1 rows; anything beyond that means the executor ignored the limit.
  if (sourceRows.length > limits.maxRows + 1)
    return reject(SqlValidationCodes.RESULT_TOO_LARGE, "Executor returned more rows than the query limit");
  const truncated = sourceRows.length > limits.maxRows;
  const rows = [];
  let bytes = 2;
  for (const sourceRow of sourceRows.slice(0, limits.maxRows)) {
    if (!Array.isArray(sourceRow) || sourceRow.length !== columns.length) {
      return reject(SqlValidationCodes.RESULT_SHAPE_INVALID, "Executor result row does not match its columns");
    }
    const row = [];
    for (const value of sourceRow) {
      const cell = toCell(value);
      if (cell === undefined)
        return reject(SqlValidationCodes.RESULT_SHAPE_INVALID, "Executor result contains a non-scalar value");
      row.push(cell);
    }
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes > limits.maxResultBytes)
      return reject(SqlValidationCodes.RESULT_TOO_LARGE, `Result exceeds ${String(limits.maxResultBytes)} bytes`);
    rows.push(Object.freeze(row));
  }
  return Object.freeze({ ok: true, columns: Object.freeze(columns), rows: Object.freeze(rows), truncated });
}
