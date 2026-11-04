import { createHash } from "node:crypto";
import libpgQuery from "libpg-query";
import { AiServiceError } from "../../errors/AiServiceError.js";
import { ErrorCodes } from "../../errors/ErrorCodes.js";
import { isSqlPolicy } from "../SqlPolicy.js";
import { brandValidatedQuery, reject, SqlValidationCodes } from "../SqlValidation.js";
import { asArray, asObject, nodeOf, treeSize } from "./AstHelpers.js";
import { lexicalCheck } from "./LexicalCheck.js";
import { checkStatement, StatementRejected } from "./StatementChecker.js";

/**
 * Also has every field of SqlValidator.
 * @typedef {Object} PostgresSqlValidator
 * @property {"postgres"} dialect
 * @property {SqlPolicy} policy
 * @property {(sql: string) => Promise<SqlValidationOutcome>} validate - Validates one generated statement against the policy and rewrites it for execution: values compared with columns become $n bind parameters and the row limit is enforced. Never executes anything. Resolves to a rejection (never throws) for any statement that is not allowed.
 */

// libpg-query is CommonJS: take parse from its default export.
const { parse } = libpgQuery;

const STRING_LITERAL = /^'(?:[^']|'')*'/;
const NUMBER_LITERAL = /^-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/;

/** Parses and checks one statement; the statement must be exactly one SELECT. */
async function parseAndCheck(sql, policy, allowParams) {
  const lexical = lexicalCheck(sql, allowParams ? policy.maxSqlChars + 200 : policy.maxSqlChars, allowParams);
  if (!lexical.ok) return lexical;

  let tree;
  try {
    tree = await parse(lexical.sql);
  } catch {
    // The parser's message quotes the offending token, so only a generic reason is returned.
    return reject(SqlValidationCodes.SQL_PARSE_FAILED, "SQL could not be parsed as PostgreSQL");
  }
  const size = treeSize(tree);
  if (size.nodes > policy.maxAstNodes || size.depth > policy.maxAstDepth) {
    return reject(SqlValidationCodes.SQL_TOO_COMPLEX, "SQL is too complex");
  }
  const statements = asArray(asObject(tree)?.stmts);
  if (statements.length !== 1) return reject(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "Exactly one statement is allowed");
  const statement = nodeOf(asObject(statements[0])?.stmt);
  if (statement?.[0] !== "SelectStmt")
    return reject(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "Only SELECT statements are allowed");

  try {
    return { ok: true, sql: lexical.sql, check: checkStatement(statement[1], policy, { allowParams }) };
  } catch (error) {
    if (error instanceof StatementRejected) return reject(error.code, error.reason);
    // Anything unexpected while walking the tree fails closed.
    return reject(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "SQL could not be validated");
  }
}

/**
 * Rewrites the statement text at the parser's byte offsets: liftable literals become $1..$n (numbered in
 * source order) and the top-level LIMIT is added or lowered to maxRows + 1. Returns undefined if a
 * literal is not found exactly where the parser put it, so the caller fails closed.
 */
function rewrite(sql, check, maxRows) {
  const bytes = Buffer.from(sql, "utf8");
  const edits = [];
  const params = [];
  const ordered = [...check.literals].sort((a, b) => a.location - b.location);
  const seen = new Set();
  for (const literal of ordered) {
    if (seen.has(literal.location)) continue;
    seen.add(literal.location);
    const rest = bytes.subarray(literal.location).toString("utf8");
    const match = (literal.kind === "string" ? STRING_LITERAL : NUMBER_LITERAL).exec(rest);
    if (match === null || !literalText(match[0], literal)) return undefined;
    params.push(literal.value);
    edits.push({
      start: literal.location,
      end: literal.location + Buffer.byteLength(match[0], "utf8"),
      text: `$${String(params.length)}`,
    });
  }

  const cap = maxRows + 1;
  let limit = cap;
  let suffix = "";
  if (check.topLimit === null) {
    suffix = ` LIMIT ${String(cap)}`;
  } else if (check.topLimit.value > maxRows) {
    const location = check.topLimit.location;
    if (location === undefined) return undefined;
    const match = /^\d+/.exec(bytes.subarray(location).toString("utf8"));
    if (match === null) return undefined;
    edits.push({ start: location, end: location + match[0].length, text: String(cap) });
  } else {
    limit = check.topLimit.value;
  }

  edits.sort((a, b) => b.start - a.start);
  let output = bytes;
  for (const edit of edits) {
    output = Buffer.concat([output.subarray(0, edit.start), Buffer.from(edit.text, "utf8"), output.subarray(edit.end)]);
  }
  return { sql: output.toString("utf8") + suffix, params, limit };
}

/** The literal's source text must spell exactly the value the parser reported. */
function literalText(text, literal) {
  if (literal.kind === "string") return text.slice(1, -1).replaceAll("''", "'") === literal.value;
  return Number(text) === Number(literal.value);
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * PostgreSQL validator for one policy (see defineSqlPolicy). It parses with PostgreSQL's own grammar
 * (libpg-query), walks the tree against the policy's allow-lists, rewrites the statement, and then parses
 * and checks the rewritten text again, so what is returned is exactly what was validated.
 */
export function createPostgresSqlValidator(policy) {
  // dialect is checked at runtime: the policy may come from untyped JavaScript.
  if (!isSqlPolicy(policy) || policy.dialect !== "postgres") {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A PostgreSQL policy from defineSqlPolicy() is required");
  }

  async function validate(sql) {
    if (typeof sql !== "string") return reject(SqlValidationCodes.SQL_EMPTY, "SQL must be a string");
    const first = await parseAndCheck(sql, policy, false);
    if (!first.ok) return first;

    const rewritten = rewrite(first.sql, first.check, policy.maxRows);
    if (rewritten === undefined) return reject(SqlValidationCodes.SQL_REWRITE_FAILED, "SQL could not be parameterised safely");

    // Second pass over the exact text that will run.
    const second = await parseAndCheck(rewritten.sql, policy, true);
    if (!second.ok) return reject(SqlValidationCodes.SQL_REWRITE_FAILED, `Rewritten SQL failed validation (${second.code})`);
    const expectedParams = new Set(rewritten.params.map((_, index) => index + 1));
    if (
      second.check.literals.length !== 0 ||
      second.check.paramRefs.size !== expectedParams.size ||
      ![...expectedParams].every((n) => second.check.paramRefs.has(n)) ||
      second.check.topLimit?.value !== rewritten.limit ||
      !sameSet(first.check.tables, second.check.tables) ||
      !sameSet(first.check.columns, second.check.columns)
    ) {
      return reject(SqlValidationCodes.SQL_REWRITE_FAILED, "Rewritten SQL does not match the validated statement");
    }

    return {
      ok: true,
      query: brandValidatedQuery({
        dialect: "postgres",
        sql: rewritten.sql,
        params: rewritten.params,
        tables: [...first.check.tables].sort(),
        columns: [...first.check.columns].sort(),
        limit: rewritten.limit,
        maxRows: policy.maxRows,
        timeoutMs: policy.timeoutMs,
        fingerprint: createHash("sha256").update(rewritten.sql).digest("hex"),
      }),
    };
  }

  return Object.freeze({ dialect: "postgres", policy, validate });
}
