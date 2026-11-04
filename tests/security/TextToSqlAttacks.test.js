import "../helpers/NoNetwork.js";
import { describe, it } from "node:test";
import { SqlValidationCodes as C } from "../../src/index.js";
import { expectRejected, syntheticValidator } from "../helpers/SqlFixtures.js";

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
