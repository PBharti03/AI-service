import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";

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
