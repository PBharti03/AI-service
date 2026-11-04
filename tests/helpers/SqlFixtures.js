import assert from "node:assert/strict";
import { defineSqlPolicy } from "../../src/index.js";
import { createPostgresSqlValidator } from "../../src/text-to-sql/postgres/index.js";

/**
 * Synthetic lead-analytics schema for text-to-SQL tests. lead_events.email and the contacts table are
 * present in the schema but never allowed, to prove the policy (not the schema) decides access.
 */
export const syntheticSqlSchema = {
  tables: [
    {
      name: "lead_events",
      description: "One row per synthetic lead",
      columns: [
        { name: "lead_id", type: "uuid", role: "identifier" },
        {
          name: "source",
          type: "text",
          allowedValues: ["meta_lead_ads", "facebook_comments", "instagram_comments", "linkedin", "google_forms"],
        },
        { name: "platform", type: "text", allowedValues: ["Facebook", "Instagram", "LinkedIn", "Google"] },
        { name: "status", type: "text", allowedValues: ["New", "Contacted", "Won", "Lost"] },
        { name: "form_id", type: "text" },
        { name: "created_at", type: "timestamptz", role: "time" },
        { name: "created_date", type: "date", role: "time" },
        { name: "is_test", type: "boolean" },
        { name: "amount", type: "numeric", role: "measure" },
        { name: "email", type: "text" },
      ],
    },
    {
      name: "lead_forms",
      columns: [
        { name: "form_id", type: "text" },
        { name: "form_name", type: "text" },
      ],
    },
    {
      name: "contacts",
      columns: [
        { name: "email", type: "text" },
        { name: "phone", type: "text" },
      ],
    },
    {
      name: "MetaLeads",
      columns: [
        { name: "LeadStatus", type: "text" },
        { name: "CreatedAt", type: "timestamptz" },
      ],
    },
  ],
  relationships: [{ from: "lead_events.form_id", to: "lead_forms.form_id" }],
};

export const syntheticSqlPolicy = {
  allowedTables: ["lead_events", "lead_forms", "MetaLeads"],
  allowedColumns: {
    lead_events: ["lead_id", "source", "platform", "status", "form_id", "created_at", "created_date", "is_test", "amount"],
    lead_forms: ["form_id", "form_name"],
    MetaLeads: ["LeadStatus", "CreatedAt"],
  },
  maxRows: 100,
  timeoutMs: 5000,
};

export function syntheticValidator(overrides = {}) {
  const policy = defineSqlPolicy({
    dialect: "postgres",
    schema: structuredClone(syntheticSqlSchema),
    policy: { ...structuredClone(syntheticSqlPolicy), ...overrides },
  });
  return createPostgresSqlValidator(policy);
}

export async function expectAccepted(validator, sql) {
  const outcome = await validator.validate(sql);
  assert.ok(outcome.ok, `expected acceptance, got ${outcome.ok ? "" : `${outcome.code}: ${outcome.reason}`}`);
  return outcome.query;
}

export async function expectRejected(validator, sql, code) {
  const outcome = await validator.validate(sql);
  if (outcome.ok) assert.fail(`expected ${code}, but the statement was accepted`);
  assert.equal(outcome.code, code, `expected ${code}, got ${outcome.code} (${outcome.reason})`);
  return outcome.reason;
}
