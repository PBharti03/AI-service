import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidatedQuery, SqlValidationCodes } from "../../src/index.js";
import { expectAccepted, expectRejected, syntheticValidator } from "../helpers/SqlFixtures.js";

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
