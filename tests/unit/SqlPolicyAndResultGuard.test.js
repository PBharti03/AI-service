import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkQueryResult, defineSqlPolicy, ErrorCodes, isSqlPolicy, SqlValidationCodes } from "../../src/index.js";
import { createPostgresSqlValidator } from "../../src/text-to-sql/postgres/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { syntheticSqlPolicy, syntheticSqlSchema } from "../helpers/SqlFixtures.js";

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
