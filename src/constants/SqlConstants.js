export const SQL_DIALECTS = ["postgres"];

export const SQL_COLUMN_TYPES = ["text", "integer", "numeric", "boolean", "date", "timestamp", "timestamptz", "uuid"];

/** count(*) is always allowed when count is. */
export const SQL_AGGREGATE_FUNCTIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);

/** Side-effect-free functions a policy may allow. Applications can narrow this list, never extend it. */
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

/** Only with allowWindowFunctions. */
export const SQL_SAFE_WINDOW_FUNCTIONS = Object.freeze(["row_number", "rank", "dense_rank", "lag", "lead"]);
