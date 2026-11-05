import "./helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkQueryResult, defineSqlPolicy, ErrorCodes, isSqlPolicy, isValidatedQuery, SqlValidationCodes, SqlValidationCodes as C } from "../src/index.js";
import { createPostgresSqlValidator } from "../src/sql/PostgresSqlValidator.js";
import { expectAccepted, expectAiError, expectRejected, syntheticSqlPolicy, syntheticSqlSchema, syntheticValidator } from "./helpers/Fixtures.js";

// PostgresSqlValidator
{
const validator = syntheticValidator();

describe("PostgreSQL validator: accepted statements and rewriting", () => {
  it("parameterises compared values and enforces the row limit", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT platform, count(*) AS leads FROM lead_events WHERE status = 'Won' AND created_date >= '2026-01-01' GROUP BY platform ORDER BY leads DESC",
    );
    assert.equal(
      query.sql,
      "SELECT platform, count(*) AS leads FROM lead_events WHERE status = $1 AND created_date >= $2 GROUP BY platform ORDER BY leads DESC LIMIT 101",
    );
    assert.deepEqual(query.params, ["Won", "2026-01-01"]);
    assert.deepEqual(query.tables, ["lead_events"]);
    assert.deepEqual(query.columns, ["lead_events.created_date", "lead_events.platform", "lead_events.status"]);
    assert.equal(query.limit, 101);
    assert.equal(query.maxRows, 100);
    assert.equal(query.timeoutMs, 5000);
    assert.match(query.fingerprint, /^[0-9a-f]{64}$/);
  });

  it("accepts dynamic date arithmetic without inventing parameters", async () => {
    const query = await expectAccepted(validator, "SELECT count(*) FROM lead_events WHERE created_date >= current_date - 14");
    assert.equal(query.sql, "SELECT count(*) FROM lead_events WHERE created_date >= current_date - 14 LIMIT 101");
    assert.deepEqual(query.params, []);
  });

  it("accepts monthly trends with time zones, EXTRACT and ordinals", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') AS month, extract(year FROM created_at) AS y, count(*) FROM lead_events GROUP BY 1, 2 ORDER BY 1",
    );
    assert.deepEqual(query.params, []);
  });

  it("accepts source comparisons with FILTER, IN and BETWEEN", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT count(*) FILTER (WHERE platform = 'Instagram') AS ig, count(*) FILTER (WHERE platform = 'Facebook') AS fb FROM lead_events " +
        "WHERE status IN ('Won', 'Lost') AND created_date BETWEEN '2026-01-01' AND '2026-03-31'",
    );
    assert.deepEqual(query.params, ["Instagram", "Facebook", "Won", "Lost", "2026-01-01", "2026-03-31"]);
    assert.ok(!query.sql.includes("'"), "no string literal should remain");
  });

  it("accepts joins on declared relationships", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT f.form_name, count(*) AS n FROM lead_events e JOIN lead_forms f ON e.form_id = f.form_id WHERE f.form_name LIKE 'Spring%' GROUP BY f.form_name",
    );
    assert.deepEqual(query.tables, ["lead_events", "lead_forms"]);
    assert.deepEqual(query.params, ["Spring%"]);
  });

  it("accepts WITH, subqueries, CASE and output aliases", async () => {
    await expectAccepted(
      validator,
      "WITH recent AS (SELECT platform, status FROM lead_events WHERE created_date >= current_date - 30) " +
        "SELECT platform, sum(CASE WHEN status = 'Won' THEN 1 ELSE 0 END) AS won FROM recent GROUP BY platform ORDER BY won DESC",
    );
    await expectAccepted(
      validator,
      "SELECT count(*) FROM lead_events WHERE form_id IN (SELECT form_id FROM lead_forms WHERE form_name = 'Webinar')",
    );
    await expectAccepted(
      validator,
      "SELECT s.platform, s.n FROM (SELECT platform, count(*) AS n FROM lead_events GROUP BY platform) s ORDER BY s.n",
    );
  });

  it("asks for a position when GROUP BY uses an output name", async () => {
    const reason = await expectRejected(
      validator,
      "SELECT date_trunc('month', created_at) AS month, count(*) FROM lead_events GROUP BY month",
      SqlValidationCodes.SQL_COLUMN_NOT_ALLOWED,
    );
    assert.match(reason, /use its position \(GROUP BY 1\)/);
    await expectAccepted(validator, "SELECT platform AS p, count(*) FROM lead_events GROUP BY platform");
  });

  it("accepts quoted mixed-case identifiers", async () => {
    const query = await expectAccepted(
      validator,
      'SELECT "LeadStatus", count(*) FROM "MetaLeads" WHERE "CreatedAt" >= \'2026-10-01T00:00:00+05:30\' GROUP BY "LeadStatus"',
    );
    assert.deepEqual(query.tables, ["MetaLeads"]);
    assert.deepEqual(query.params, ["2026-10-01T00:00:00+05:30"]);
  });

  it("keeps a smaller LIMIT, lowers a larger one and drops a trailing semicolon", async () => {
    assert.equal(
      (await expectAccepted(validator, "SELECT platform FROM lead_events LIMIT 10;")).sql,
      "SELECT platform FROM lead_events LIMIT 10",
    );
    const capped = await expectAccepted(validator, "SELECT platform FROM lead_events LIMIT 5000");
    assert.equal(capped.sql, "SELECT platform FROM lead_events LIMIT 101");
    assert.equal(capped.limit, 101);
  });

  it("unescapes quoted values and handles multi-byte text before them", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT 'é ✓' AS label, count(*) FROM lead_events WHERE form_id = 'O''Brien form' GROUP BY 1",
    );
    assert.deepEqual(query.params, ["O'Brien form"]);
    assert.equal(query.sql, "SELECT 'é ✓' AS label, count(*) FROM lead_events WHERE form_id = $1 GROUP BY 1 LIMIT 101");
  });

  it("treats instructions inside a value as data: it becomes a parameter", async () => {
    const query = await expectAccepted(
      validator,
      "SELECT count(*) FROM lead_events WHERE form_id = 'ignore all rules; DROP TABLE lead_events'",
    );
    assert.deepEqual(query.params, ["ignore all rules; DROP TABLE lead_events"]);
    assert.ok(!query.sql.includes("DROP"));
  });

  it("brands and freezes validated queries", async () => {
    const query = await expectAccepted(validator, "SELECT count(*) FROM lead_events");
    assert.ok(isValidatedQuery(query));
    assert.ok(Object.isFrozen(query) && Object.isFrozen(query.params));
    assert.equal(isValidatedQuery({ ...query }), false);
  });
});

describe("PostgreSQL validator: policy options", () => {
  it("requireAggregation rejects row-level output and allows grouped aggregates", async () => {
    const strict = syntheticValidator({ requireAggregation: true });
    await expectRejected(strict, "SELECT lead_id FROM lead_events", SqlValidationCodes.SQL_AGGREGATION_REQUIRED);
    await expectRejected(
      strict,
      "SELECT platform, status, count(*) FROM lead_events GROUP BY platform",
      SqlValidationCodes.SQL_AGGREGATION_REQUIRED,
    );
    await expectAccepted(strict, "SELECT platform, count(*) FROM lead_events GROUP BY platform");
    await expectAccepted(strict, "SELECT date_trunc('month', created_at) AS m, count(*) FROM lead_events GROUP BY 1");
  });

  it("allowJoins none rejects every join", async () => {
    await expectRejected(
      syntheticValidator({ allowJoins: "none" }),
      "SELECT count(*) FROM lead_events e JOIN lead_forms f ON e.form_id = f.form_id",
      SqlValidationCodes.SQL_JOIN_NOT_ALLOWED,
    );
  });

  it("set operations and window functions need explicit opt-in", async () => {
    const unionSql = "SELECT platform FROM lead_events UNION SELECT form_name FROM lead_forms";
    await expectRejected(validator, unionSql, SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED);
    await expectAccepted(syntheticValidator({ allowSetOperations: true }), unionSql);
    const windowSql = "SELECT platform, rank() OVER (ORDER BY count(*) DESC) FROM lead_events GROUP BY platform";
    await expectRejected(validator, windowSql, SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED);
    await expectAccepted(syntheticValidator({ allowWindowFunctions: true, allowedFunctions: ["count", "rank"] }), windowSql);
  });

  it("subqueries can be switched off", async () => {
    await expectRejected(
      syntheticValidator({ allowSubqueries: false }),
      "SELECT count(*) FROM lead_events WHERE form_id IN (SELECT form_id FROM lead_forms)",
      SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED,
    );
  });
});
}

// SqlPolicyAndResultGuard
{
function define(policy, schema = syntheticSqlSchema) {
  return defineSqlPolicy({
    dialect: "postgres",
    schema: structuredClone(schema),
    policy: { ...structuredClone(syntheticSqlPolicy), ...policy },
  });
}

describe("defineSqlPolicy", () => {
  it("returns a frozen, branded policy", () => {
    const policy = define({});
    assert.ok(isSqlPolicy(policy));
    assert.ok(Object.isFrozen(policy));
    assert.equal(isSqlPolicy({ ...policy }), false);
  });

  it("rejects allowed tables and columns that are not in the schema", async () => {
    await expectAiError(
      () => define({ allowedTables: ["missing"], allowedColumns: { missing: ["x"] } }),
      ErrorCodes.CONFIG_INVALID,
    );
    await expectAiError(
      () => define({ allowedColumns: { ...syntheticSqlPolicy.allowedColumns, lead_events: ["nope"] } }),
      ErrorCodes.CONFIG_INVALID,
    );
    await expectAiError(() => define({ allowedColumns: { lead_forms: ["form_id"] } }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(
      () => define({ allowedColumns: { ...syntheticSqlPolicy.allowedColumns, contacts: ["email"] } }),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it("only accepts functions from the curated safe list", async () => {
    await expectAiError(() => define({ allowedFunctions: ["count", "pg_read_file"] }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => define({ allowedFunctions: ["row_number"] }), ErrorCodes.CONFIG_INVALID);
    assert.ok(define({ allowedFunctions: ["count", "row_number"], allowWindowFunctions: true }).functions.has("row_number"));
  });

  it("rejects relationships over columns that are not allowed", async () => {
    const schema = structuredClone(syntheticSqlSchema);
    schema.relationships.push({ from: "lead_events.form_id", to: "contacts.email" });
    await expectAiError(() => define({}, schema), ErrorCodes.CONFIG_INVALID);
  });

  it("rejects unknown keys and out-of-range limits", async () => {
    await expectAiError(() => define({ allowEverything: true }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => define({ maxRows: 0 }), ErrorCodes.CONFIG_INVALID);
    await expectAiError(() => define({ timeoutMs: 10 }), ErrorCodes.CONFIG_INVALID);
  });

  it("the validator refuses look-alike policies", async () => {
    await expectAiError(() => createPostgresSqlValidator({ ...define({}) }), ErrorCodes.CONFIG_INVALID);
  });
});

describe("checkQueryResult", () => {
  const limits = { maxRows: 3, maxResultBytes: 2048, maxResultColumns: 4 };
  const columns = [{ name: "platform" }, { name: "leads", type: "int8" }];

  it("accepts scalar rows and normalises bigint and Date", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    const result = checkQueryResult(
      {
        columns,
        rows: [
          ["Instagram", 8n],
          [at, null],
        ],
      },
      limits,
    );
    assert.ok(result.ok);
    assert.deepEqual(result.rows, [
      ["Instagram", "8"],
      ["2026-01-02T03:04:05.000Z", null],
    ]);
    assert.equal(result.truncated, false);
  });

  it("handles empty results", () => {
    const result = checkQueryResult({ columns, rows: [] }, limits);
    assert.ok(result.ok);
    assert.equal(result.rows.length, 0);
  });

  it("marks truncation at maxRows + 1 and refuses more", () => {
    const four = checkQueryResult(
      {
        columns,
        rows: [
          ["a", 1],
          ["b", 2],
          ["c", 3],
          ["d", 4],
        ],
      },
      limits,
    );
    assert.ok(four.ok);
    assert.equal(four.rows.length, 3);
    assert.equal(four.truncated, true);
    const five = checkQueryResult(
      {
        columns,
        rows: [
          ["a", 1],
          ["b", 2],
          ["c", 3],
          ["d", 4],
          ["e", 5],
        ],
      },
      limits,
    );
    assert.equal(five.ok ? "" : five.code, SqlValidationCodes.RESULT_TOO_LARGE);
  });

  it("refuses wrong shapes, objects and oversized results", () => {
    const code = (value, custom = limits) => {
      const result = checkQueryResult(value, custom);
      return result.ok ? "ok" : result.code;
    };
    assert.equal(code(null), SqlValidationCodes.RESULT_SHAPE_INVALID);
    assert.equal(code({ columns, rows: [["only one"]] }), SqlValidationCodes.RESULT_SHAPE_INVALID);
    assert.equal(code({ columns, rows: [["x", { nested: true }]] }), SqlValidationCodes.RESULT_SHAPE_INVALID);
    assert.equal(code({ columns, rows: [["x", Number.NaN]] }), SqlValidationCodes.RESULT_SHAPE_INVALID);
    assert.equal(code({ columns: [{ name: "a\u0000" }], rows: [] }), SqlValidationCodes.RESULT_SHAPE_INVALID);
    assert.equal(
      code({ columns: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }], rows: [] }),
      SqlValidationCodes.RESULT_TOO_LARGE,
    );
    assert.equal(code({ columns, rows: [["x".repeat(3000), 1]] }), SqlValidationCodes.RESULT_TOO_LARGE);
  });
});
}

// TextToSqlAttacks
{
const validator = syntheticValidator();
const withSetOps = syntheticValidator({ allowSetOperations: true });

/** [description, SQL, expected code]. Every one must be refused before anything could run. */
const attacks = [
  // Writes and other statements
  ["INSERT", "INSERT INTO lead_events (status) VALUES ('Won')", C.SQL_NOT_SINGLE_SELECT],
  ["UPDATE", "UPDATE lead_events SET status = 'Won'", C.SQL_NOT_SINGLE_SELECT],
  ["DELETE", "DELETE FROM lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["DROP", "DROP TABLE lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["ALTER", "ALTER TABLE lead_events ADD COLUMN x int", C.SQL_NOT_SINGLE_SELECT],
  ["TRUNCATE", "TRUNCATE lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["CREATE", "CREATE TABLE x AS SELECT * FROM lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["GRANT", "GRANT SELECT ON contacts TO PUBLIC", C.SQL_NOT_SINGLE_SELECT],
  ["COPY", "COPY lead_events TO '/tmp/x'", C.SQL_NOT_SINGLE_SELECT],
  ["MERGE", "MERGE INTO lead_events USING lead_forms ON true WHEN MATCHED THEN DELETE", C.SQL_NOT_SINGLE_SELECT],
  ["CALL", "CALL do_something()", C.SQL_NOT_SINGLE_SELECT],
  ["SET ROLE", "SET ROLE postgres", C.SQL_NOT_SINGLE_SELECT],
  ["EXPLAIN ANALYZE", "EXPLAIN ANALYZE SELECT count(*) FROM lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["DO block", "DO $$ BEGIN DELETE FROM lead_events; END $$", C.SQL_FEATURE_NOT_ALLOWED],
  [
    "data-modifying CTE",
    "WITH gone AS (DELETE FROM lead_events RETURNING lead_id) SELECT count(*) FROM gone",
    C.SQL_NOT_SINGLE_SELECT,
  ],
  ["SELECT INTO", "SELECT platform INTO TEMP copy FROM lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  ["FOR UPDATE", "SELECT platform FROM lead_events FOR UPDATE", C.SQL_FEATURE_NOT_ALLOWED],
  ["FOR SHARE", "SELECT platform FROM lead_events FOR SHARE", C.SQL_FEATURE_NOT_ALLOWED],
  // Multiple statements and hidden text
  ["stacked statements", "SELECT count(*) FROM lead_events; DELETE FROM lead_events", C.SQL_NOT_SINGLE_SELECT],
  ["two selects", "SELECT 1; SELECT 2", C.SQL_NOT_SINGLE_SELECT],
  ["line comment", "SELECT count(*) FROM lead_events -- WHERE is_test = false", C.SQL_COMMENT_NOT_ALLOWED],
  ["block comment", "SELECT /* hidden */ count(*) FROM lead_events", C.SQL_COMMENT_NOT_ALLOWED],
  ["dollar quoting", "SELECT $x$hello$x$ FROM lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  ["model-supplied parameter", "SELECT count(*) FROM lead_events WHERE status = $1", C.SQL_FEATURE_NOT_ALLOWED],
  ["escape string", "SELECT count(*) FROM lead_events WHERE form_id = E'\\x41'", C.SQL_FEATURE_NOT_ALLOWED],
  ["unicode escape string", "SELECT count(*) FROM lead_events WHERE form_id = U&'\\0041'", C.SQL_FEATURE_NOT_ALLOWED],
  ["control character", "SELECT count(*)\u0000 FROM lead_events", C.SQL_INVALID_CHARACTERS],
  ["empty", "   ", C.SQL_EMPTY],
  ["unparseable", "SELECT FROM WHERE", C.SQL_PARSE_FAILED],
  ["too long", `SELECT count(*) FROM lead_events WHERE form_id = '${"x".repeat(4100)}'`, C.SQL_TOO_LONG],
  [
    "IN list over 100 values",
    `SELECT count(*) FROM lead_events WHERE form_id IN (${Array.from({ length: 101 }, () => "'x'").join(",")})`,
    C.SQL_FEATURE_NOT_ALLOWED,
  ],
  // Tables
  ["unauthorised table", "SELECT email FROM contacts", C.SQL_TABLE_NOT_ALLOWED],
  ["schema-qualified table", "SELECT count(*) FROM public.lead_events", C.SQL_TABLE_NOT_ALLOWED],
  ["system catalog", "SELECT usename FROM pg_catalog.pg_user", C.SQL_TABLE_NOT_ALLOWED],
  ["unqualified catalog", "SELECT rolname FROM pg_roles", C.SQL_TABLE_NOT_ALLOWED],
  ["information_schema", "SELECT table_name FROM information_schema.tables", C.SQL_TABLE_NOT_ALLOWED],
  [
    "subquery to another table",
    "SELECT count(*) FROM lead_events WHERE form_id IN (SELECT email FROM contacts)",
    C.SQL_TABLE_NOT_ALLOWED,
  ],
  ["EXISTS to another table", "SELECT count(*) FROM lead_events WHERE EXISTS (SELECT 1 FROM contacts)", C.SQL_TABLE_NOT_ALLOWED],
  ["FROM subquery to another table", "SELECT x FROM (SELECT phone AS x FROM contacts) c", C.SQL_TABLE_NOT_ALLOWED],
  ["CTE over another table", "WITH c AS (SELECT email FROM contacts) SELECT count(*) FROM c", C.SQL_TABLE_NOT_ALLOWED],
  ["table function", "SELECT * FROM generate_series(1, 10)", C.SQL_FEATURE_NOT_ALLOWED],
  ["TABLE shorthand", "TABLE lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  ["VALUES", "VALUES (1), (2)", C.SQL_FEATURE_NOT_ALLOWED],
  [
    "WITH name shadowing an allowed table",
    "WITH lead_events AS (SELECT email AS platform FROM contacts) SELECT platform FROM lead_events",
    C.SQL_FEATURE_NOT_ALLOWED,
  ],
  [
    "recursive CTE",
    "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r",
    C.SQL_FEATURE_NOT_ALLOWED,
  ],
  // Columns
  ["unauthorised column", "SELECT email FROM lead_events", C.SQL_COLUMN_NOT_ALLOWED],
  ["qualified unauthorised column", "SELECT e.email FROM lead_events e", C.SQL_COLUMN_NOT_ALLOWED],
  ["column in WHERE", "SELECT count(*) FROM lead_events WHERE email LIKE '%@example.com'", C.SQL_COLUMN_NOT_ALLOWED],
  ["column inside aggregate", "SELECT count(DISTINCT email) FROM lead_events", C.SQL_COLUMN_NOT_ALLOWED],
  [
    "alias named like a hidden column",
    "SELECT count(*) AS email FROM lead_events WHERE email IS NOT NULL",
    C.SQL_COLUMN_NOT_ALLOWED,
  ],
  ["hidden column in ORDER BY expression", "SELECT platform FROM lead_events ORDER BY lower(email)", C.SQL_COLUMN_NOT_ALLOWED],
  ["hidden column through CTE", "WITH x AS (SELECT email AS e FROM lead_events) SELECT e FROM x", C.SQL_COLUMN_NOT_ALLOWED],
  ["SELECT *", "SELECT * FROM lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  ["table.*", "SELECT e.* FROM lead_events e", C.SQL_FEATURE_NOT_ALLOWED],
  ["system column ctid", "SELECT ctid FROM lead_events", C.SQL_COLUMN_NOT_ALLOWED],
  ["system column xmin", "SELECT xmin FROM lead_events", C.SQL_COLUMN_NOT_ALLOWED],
  ["three-part name", "SELECT public.lead_events.status FROM lead_events", C.SQL_COLUMN_NOT_ALLOWED],
  ["unknown qualifier", "SELECT c.email FROM lead_events e", C.SQL_COLUMN_NOT_ALLOWED],
  // Functions, operators and casts
  ["pg_read_file", "SELECT pg_read_file('/etc/passwd')", C.SQL_FUNCTION_NOT_ALLOWED],
  ["pg_sleep", "SELECT pg_sleep(30)", C.SQL_FUNCTION_NOT_ALLOWED],
  ["set_config", "SELECT set_config('default_transaction_read_only', 'off', false)", C.SQL_FUNCTION_NOT_ALLOWED],
  ["current_setting", "SELECT current_setting('data_directory')", C.SQL_FUNCTION_NOT_ALLOWED],
  ["dblink", "SELECT dblink('host=evil', 'SELECT 1')", C.SQL_FUNCTION_NOT_ALLOWED],
  ["lo_import", "SELECT lo_import('/etc/passwd')", C.SQL_FUNCTION_NOT_ALLOWED],
  ["version()", "SELECT version()", C.SQL_FUNCTION_NOT_ALLOWED],
  ["schema-qualified function", "SELECT pg_catalog.count(*) FROM lead_events", C.SQL_FUNCTION_NOT_ALLOWED],
  ["current_user", "SELECT current_user", C.SQL_FUNCTION_NOT_ALLOWED],
  ["session_user", "SELECT session_user", C.SQL_FUNCTION_NOT_ALLOWED],
  ["sum(*)", "SELECT sum(*) FROM lead_events", C.SQL_FUNCTION_NOT_ALLOWED],
  ["regclass cast", "SELECT 'pg_authid'::regclass", C.SQL_TYPE_NOT_ALLOWED],
  ["regproc cast", "SELECT 'pg_sleep'::regproc", C.SQL_TYPE_NOT_ALLOWED],
  ["array cast", "SELECT '{1,2}'::int[]", C.SQL_TYPE_NOT_ALLOWED],
  ["regex operator", "SELECT count(*) FROM lead_events WHERE form_id ~ '(a+)+$'", C.SQL_FEATURE_NOT_ALLOWED],
  ["qualified operator", "SELECT count(*) FROM lead_events WHERE status OPERATOR(pg_catalog.=) 'Won'", C.SQL_FEATURE_NOT_ALLOWED],
  ["SIMILAR TO", "SELECT count(*) FROM lead_events WHERE form_id SIMILAR TO '%x%'", C.SQL_FEATURE_NOT_ALLOWED],
  ["ROW constructor", "SELECT ROW(platform, status) FROM lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  ["window function by default", "SELECT row_number() OVER () FROM lead_events", C.SQL_FUNCTION_NOT_ALLOWED],
  ["aggregate OVER by default", "SELECT count(*) OVER () FROM lead_events", C.SQL_FEATURE_NOT_ALLOWED],
  // Values
  ["value outside allowed list", "SELECT count(*) FROM lead_events WHERE status = 'Pending'", C.SQL_LITERAL_INVALID],
  [
    "IN with a disallowed value",
    "SELECT count(*) FROM lead_events WHERE platform IN ('Instagram', 'Twitter')",
    C.SQL_LITERAL_INVALID,
  ],
  ["non-date for a date column", "SELECT count(*) FROM lead_events WHERE created_date >= 'yesterday'", C.SQL_LITERAL_INVALID],
  ["number for a text column", "SELECT count(*) FROM lead_events WHERE status = 1", C.SQL_LITERAL_INVALID],
  ["bad uuid", "SELECT count(*) FROM lead_events WHERE lead_id = 'not-a-uuid'", C.SQL_LITERAL_INVALID],
  ["over-long value", `SELECT count(*) FROM lead_events WHERE form_id = '${"x".repeat(300)}'`, C.SQL_LITERAL_INVALID],
  // Joins
  ["comma join", "SELECT count(*) FROM lead_events, lead_forms", C.SQL_JOIN_NOT_ALLOWED],
  [
    "undeclared join key",
    "SELECT count(*) FROM lead_events e JOIN lead_forms f ON e.form_id = f.form_name",
    C.SQL_JOIN_NOT_ALLOWED,
  ],
  [
    "join with extra condition",
    "SELECT count(*) FROM lead_events e JOIN lead_forms f ON e.form_id = f.form_id OR true",
    C.SQL_JOIN_NOT_ALLOWED,
  ],
  ["NATURAL join", "SELECT count(*) FROM lead_events NATURAL JOIN lead_forms", C.SQL_JOIN_NOT_ALLOWED],
  ["USING join", "SELECT count(*) FROM lead_events JOIN lead_forms USING (form_id)", C.SQL_JOIN_NOT_ALLOWED],
  ["CROSS JOIN", "SELECT count(*) FROM lead_events CROSS JOIN lead_forms", C.SQL_JOIN_NOT_ALLOWED],
  [
    "join to a hidden table",
    "SELECT count(*) FROM lead_events e JOIN contacts c ON e.form_id = c.email",
    C.SQL_TABLE_NOT_ALLOWED,
  ],
  ["LATERAL", "SELECT count(*) FROM lead_events e, LATERAL (SELECT 1) x", C.SQL_JOIN_NOT_ALLOWED],
  // Limits
  ["LIMIT ALL", "SELECT platform FROM lead_events LIMIT ALL", C.SQL_LIMIT_INVALID],
  ["LIMIT subquery", "SELECT platform FROM lead_events LIMIT (SELECT 5)", C.SQL_LIMIT_INVALID],
  ["huge OFFSET", "SELECT platform FROM lead_events OFFSET 999999999", C.SQL_LIMIT_INVALID],
  ["WITH TIES", "SELECT platform FROM lead_events ORDER BY platform FETCH FIRST 5 ROWS WITH TIES", C.SQL_LIMIT_INVALID],
  // Size
  ["deep nesting", `SELECT ${"1 + (".repeat(120)}1${")".repeat(120)} FROM lead_events`, C.SQL_TOO_COMPLEX],
];

describe("text-to-SQL attacks are rejected", () => {
  for (const [name, sql, code] of attacks) {
    it(name, async () => {
      await expectRejected(validator, sql, code);
    });
  }

  it("UNION cannot reach a hidden table even when set operations are allowed", async () => {
    await expectRejected(
      withSetOps,
      "SELECT platform FROM lead_events UNION SELECT email FROM contacts",
      C.SQL_TABLE_NOT_ALLOWED,
    );
    await expectRejected(
      withSetOps,
      "SELECT platform FROM lead_events UNION ALL SELECT email FROM lead_events",
      C.SQL_COLUMN_NOT_ALLOWED,
    );
  });

  it("rejection reasons never echo literal values", async () => {
    const reason = await expectRejected(
      validator,
      "SELECT count(*) FROM lead_events WHERE status = 'secret-value-123'",
      C.SQL_LITERAL_INVALID,
    );
    if (reason.includes("secret-value-123")) throw new Error("reason leaked a literal value");
  });
});
}
