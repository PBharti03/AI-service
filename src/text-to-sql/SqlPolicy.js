import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";

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
