import { reject, SqlValidationCodes } from "./SqlValidation.js";

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
