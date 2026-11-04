import { relationshipKey } from "../SqlPolicy.js";
import { SqlValidationCodes } from "../SqlValidation.js";
import { asArray, asObject, asString, integerConst, locationOf, nodeOf, stringList, structuralKey } from "./AstHelpers.js";

/**
 * A literal compared with a column: it becomes a bind parameter when the statement is rewritten.
 * @typedef {Object} LiftableLiteral
 * @property {number} location
 * @property {"string" | "number"} kind
 * @property {SqlParam} value
 */

/**
 * @typedef {Object} CheckResult
 * @property {ReadonlySet<string>} tables
 * @property {ReadonlySet<string>} columns
 * @property {readonly LiftableLiteral[]} literals
 * @property {ReadonlySet<number>} paramRefs
 * @property {{ readonly value: number; readonly location: number | undefined } | null} topLimit
 */

/**
 * @typedef {Object} CheckOptions
 * @property {boolean} allowParams - The rewritten statement may contain $n parameters (and no longer contains liftable literals).
 */

/**
 * Allow-list walk over one PostgreSQL SELECT parse tree. Every node type, function, operator, type cast,
 * table and column must be explicitly allowed; anything unrecognised is refused. The checker never
 * executes or rewrites anything: it reports the tables and columns read, the literals that may become
 * bind parameters, and the top-level LIMIT.
 */
export class StatementRejected extends Error {
  code;
  reason;

  constructor(code, reason) {
    super(reason);
    this.name = "StatementRejected";
    this.code = code;
    this.reason = reason;
  }
}

function fail(code, reason) {
  throw new StatementRejected(code, reason);
}

/** A literal compared with a column: it becomes a bind parameter when the statement is rewritten. */

const COMPARISON_OPERATORS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);
const EQUALITY_OPERATORS = new Set(["=", "<>", "!="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%", "||"]);
const LIKE_OPERATORS = new Set(["~~", "!~~", "~~*", "!~~*"]);
const ALLOWED_SQL_VALUE_FUNCTIONS = new Set([
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
]);
/** Type casts that cannot look anything up (no regclass, regproc or other catalog-resolving types). */
const ALLOWED_CAST_TYPES = new Map([
  ["date", "date"],
  ["timestamp", "timestamp"],
  ["timestamptz", "timestamptz"],
  ["interval", null],
  ["text", "text"],
  ["varchar", "text"],
  ["int2", "integer"],
  ["int4", "integer"],
  ["int8", "integer"],
  ["integer", "integer"],
  ["bigint", "integer"],
  ["smallint", "integer"],
  ["numeric", "numeric"],
  ["decimal", "numeric"],
  ["float4", "numeric"],
  ["float8", "numeric"],
  ["bool", "boolean"],
  ["boolean", "boolean"],
]);
const JOIN_TYPES = new Set(["JOIN_INNER", "JOIN_LEFT", "JOIN_RIGHT", "JOIN_FULL"]);
const SUBLINK_TYPES = new Set(["EXISTS_SUBLINK", "ANY_SUBLINK", "EXPR_SUBLINK"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const short = (name) => name.slice(0, 64);

export function checkStatement(select, policy, options) {
  const tables = new Set();
  const columns = new Set();
  const literals = [];
  const paramRefs = new Set();

  // ── Sources and scopes ────────────────────────────────────────────────────
  function findCte(scope, name) {
    for (let current = scope; current !== null; current = current.parent) {
      const cte = current.ctes.get(name);
      if (cte !== undefined) return cte;
    }
    return undefined;
  }

  function addSource(scope, name, source) {
    if (scope.sources.has(name)) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `Name "${short(name)}" is used twice in FROM`);
    scope.sources.set(name, source);
  }

  function aliasName(body) {
    const alias = asObject(body.alias);
    if (alias === undefined) return undefined;
    if (asArray(alias.colnames).length > 0)
      fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Column aliases in FROM are not allowed");
    return asString(alias.aliasname);
  }

  /** Registers one FROM item; returns the table sources it contributed (for join checks). */
  function fromItem(item, scope) {
    const node = nodeOf(item);
    if (node === undefined) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported FROM item");
    const [type, body] = node;
    if (type === "RangeVar") {
      if (body.schemaname !== undefined || body.catalogname !== undefined) {
        fail(SqlValidationCodes.SQL_TABLE_NOT_ALLOWED, "Schema-qualified table names are not allowed");
      }
      const name = asString(body.relname) ?? "";
      const alias = aliasName(body) ?? name;
      const cte = findCte(scope, name);
      if (cte !== undefined) {
        addSource(scope, alias, { kind: "derived", columns: cte });
        return;
      }
      const allowed = policy.tables.get(name);
      if (allowed === undefined) fail(SqlValidationCodes.SQL_TABLE_NOT_ALLOWED, `Table "${short(name)}" is not allowed`);
      tables.add(name);
      addSource(scope, alias, { kind: "table", table: name, columns: allowed });
      return;
    }
    if (type === "RangeSubselect") {
      if (!policy.allowSubqueries) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Subqueries are not allowed");
      if (body.lateral === true) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "LATERAL is not allowed");
      const sub = nodeOf(body.subquery);
      if (sub?.[0] !== "SelectStmt") fail(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "A subquery must be a SELECT");
      // A non-lateral FROM subquery sees WITH names and outer queries, but not its siblings in this FROM list.
      const outputs = selectStmt(sub[1], { sources: new Map(), ctes: scope.ctes, parent: scope.parent }, false, false);
      const alias = aliasName(body) ?? `subquery_${String(scope.sources.size + 1)}`;
      addSource(scope, alias, { kind: "derived", columns: outputs });
      return;
    }
    if (type === "JoinExpr") {
      if (policy.allowJoins === "none") fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Joins are not allowed");
      if (body.isNatural === true || asArray(body.usingClause).length > 0) {
        fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "NATURAL and USING joins are not allowed; use ON with declared keys");
      }
      if (!JOIN_TYPES.has(asString(body.jointype) ?? ""))
        fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "This join type is not allowed");
      if (body.alias !== undefined) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Aliased joins are not allowed");
      for (const side of [body.larg, body.rarg]) {
        const sideType = nodeOf(side)?.[0];
        if (sideType !== "RangeVar" && sideType !== "JoinExpr")
          fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Joins may only combine allowed tables");
        fromItem(side, scope);
      }
      checkJoinCondition(body.quals, scope);
      return;
    }
    fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `FROM item ${short(type)} is not allowed`);
  }

  /** ON must be one or more ANDed equalities between columns of a declared relationship. */
  function checkJoinCondition(quals, scope) {
    const pairs = [];
    const collect = (value) => {
      const node = nodeOf(value);
      if (node?.[0] === "BoolExpr" && node[1].boolop === "AND_EXPR") {
        for (const arg of asArray(node[1].args)) collect(arg);
        return;
      }
      if (node?.[0] === "A_Expr" && node[1].kind === "AEXPR_OP" && stringList(node[1].name)?.join(".") === "=") {
        pairs.push([node[1].lexpr, node[1].rexpr]);
        return;
      }
      fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Join conditions may only be equalities on declared keys");
    };
    if (quals === undefined) fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Joins need an ON condition");
    collect(quals);
    for (const [left, right] of pairs) {
      const a = columnRef(left, scope, "join");
      const b = columnRef(right, scope, "join");
      if (
        a === null ||
        b === null ||
        !policy.relationships.has(relationshipKey(`${a.table}.${a.name}`, `${b.table}.${b.name}`))
      ) {
        fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Join keys must be a declared relationship");
      }
    }
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  /**
   * Resolves a ColumnRef to an allowed table column (returned) or a derived column (null). Output-column
   * aliases are only honoured by the caller for bare ORDER BY keys, matching PostgreSQL's own rules.
   */
  function columnRef(value, scope, clause) {
    const node = nodeOf(value);
    if (node?.[0] !== "ColumnRef") fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, `Expected a column in ${clause}`);
    const fieldNodes = asArray(node[1].fields);
    if (fieldNodes.some((field) => nodeOf(field)?.[0] === "A_Star"))
      fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "SELECT * and table.* are not allowed");
    const fields = stringList(node[1].fields);
    if (fields === undefined || fields.length === 0 || fields.length > 2)
      fail(SqlValidationCodes.SQL_COLUMN_NOT_ALLOWED, "Column references must be column or table.column");
    const column = fields[fields.length - 1] ?? "";
    const qualifier = fields.length === 2 ? fields[0] : undefined;

    for (let current = scope; current !== null; current = current.parent) {
      const candidates = [];
      if (qualifier !== undefined) {
        const source = current.sources.get(qualifier);
        if (source !== undefined) candidates.push(source);
      } else {
        candidates.push(...current.sources.values());
      }
      const matches = candidates.filter((source) => source.columns.has(column));
      if (matches.length > 1)
        fail(SqlValidationCodes.SQL_COLUMN_NOT_ALLOWED, `Column "${short(column)}" is ambiguous; qualify it`);
      const match = matches[0];
      if (match !== undefined) {
        if (match.kind === "derived") return null;
        const info = match.columns.get(column);
        if (info === undefined) break;
        columns.add(`${info.table}.${info.name}`);
        return info;
      }
      // A qualifier that names a source here but lacks the column must not fall through to outer scopes.
      if (qualifier !== undefined && current.sources.has(qualifier)) break;
    }
    fail(
      SqlValidationCodes.SQL_COLUMN_NOT_ALLOWED,
      `Column "${qualifier === undefined ? "" : `${short(qualifier)}.`}${short(column)}" is not allowed`,
    );
  }

  // ── Literals ──────────────────────────────────────────────────────────────
  function constValue(body) {
    if (body.isnull === true) return { kind: "null", value: null };
    const sval = asObject(body.sval);
    if (sval !== undefined) return { kind: "string", value: asString(sval.sval) ?? "" };
    const ival = asObject(body.ival);
    if (ival !== undefined) return { kind: "number", value: typeof ival.ival === "number" ? ival.ival : 0 };
    const fval = asObject(body.fval);
    if (fval !== undefined) return { kind: "number", value: asString(fval.fval) ?? "0" };
    const boolval = asObject(body.boolval);
    if (boolval !== undefined) return { kind: "boolean", value: boolval.boolval === true };
    return fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported constant");
  }

  function literalMatchesType(kind, value, type) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    switch (type) {
      case "text":
        return kind === "string";
      case "integer":
        return /^-?\d{1,18}$/.test(text);
      case "numeric":
        return /^-?\d{1,30}(\.\d{1,30})?$/.test(text);
      case "boolean":
        return kind === "boolean" || /^(true|false)$/i.test(text);
      case "date":
        return kind === "string" && ISO_DATE.test(text) && !Number.isNaN(Date.parse(text));
      case "timestamp":
      case "timestamptz":
        return (
          kind === "string" &&
          (ISO_DATE.test(text) || ISO_DATETIME.test(text)) &&
          !Number.isNaN(Date.parse(text.replace(" ", "T")))
        );
      case "uuid":
        return kind === "string" && UUID.test(text);
    }
  }

  /**
   * A constant compared with a table column: its type must suit the column (or the cast applied to it),
   * an equality on a column with allowedValues must use one of them, and string and number constants
   * become bind parameters.
   */
  function comparedLiteral(value, column, operator) {
    let node = nodeOf(value);
    let castType;
    if (node?.[0] === "TypeCast") {
      castType = castTarget(node[1]);
      node = nodeOf(node[1].arg);
    }
    if (node?.[0] !== "A_Const") return;
    const { kind, value: literal } = constValue(node[1]);
    if (kind === "null") return;
    const type = castType === undefined ? column.type : castType;
    if (type !== null && !literalMatchesType(kind, literal, type)) {
      fail(
        SqlValidationCodes.SQL_LITERAL_INVALID,
        `A value compared with ${short(column.table)}.${short(column.name)} does not match its type`,
      );
    }
    if (column.allowedValues !== null && EQUALITY_OPERATORS.has(operator) && !column.allowedValues.includes(String(literal))) {
      fail(
        SqlValidationCodes.SQL_LITERAL_INVALID,
        `A value compared with ${short(column.table)}.${short(column.name)} is not one of its allowed values`,
      );
    }
    const location = locationOf(node[1]);
    if ((kind === "string" || kind === "number") && location !== undefined) literals.push({ location, kind, value: literal });
  }

  function castTarget(body) {
    const typeName = asObject(body.typeName) ?? nodeOf(body.typeName)?.[1];
    if (typeName === undefined) fail(SqlValidationCodes.SQL_TYPE_NOT_ALLOWED, "Unsupported type cast");
    if (asArray(typeName.arrayBounds).length > 0 || asArray(typeName.typmods).length > 0 || typeName.setof === true) {
      fail(SqlValidationCodes.SQL_TYPE_NOT_ALLOWED, "Array, sized and SETOF casts are not allowed");
    }
    const names = stringList(typeName.names);
    if (names === undefined || names.length === 0 || names.length > 2 || (names.length === 2 && names[0] !== "pg_catalog")) {
      fail(SqlValidationCodes.SQL_TYPE_NOT_ALLOWED, "Only built-in types can be used in casts");
    }
    const name = (names[names.length - 1] ?? "").toLowerCase();
    const mapped = ALLOWED_CAST_TYPES.get(name);
    if (mapped === undefined) fail(SqlValidationCodes.SQL_TYPE_NOT_ALLOWED, `Casting to ${short(name)} is not allowed`);
    return mapped;
  }

  // ── Expressions ───────────────────────────────────────────────────────────
  function expression(value, scope, clause) {
    const node = nodeOf(value);
    if (node === undefined) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `Unsupported expression in ${clause}`);
    const [type, body] = node;
    switch (type) {
      case "ColumnRef":
        columnRef(value, scope, clause);
        return;
      case "A_Const": {
        const { kind, value: literal } = constValue(body);
        if (kind === "string" && typeof literal === "string" && literal.length > policy.maxLiteralChars) {
          fail(SqlValidationCodes.SQL_LITERAL_INVALID, "A string value is too long");
        }
        return;
      }
      case "ParamRef": {
        const number = body.number;
        if (!options.allowParams || typeof number !== "number" || number < 1)
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Parameters are not allowed");
        paramRefs.add(number);
        return;
      }
      case "TypeCast":
        castTarget(body);
        expression(body.arg, scope, clause);
        return;
      case "A_Expr":
        operatorExpression(body, scope, clause);
        return;
      case "BoolExpr":
        if (!["AND_EXPR", "OR_EXPR", "NOT_EXPR"].includes(asString(body.boolop) ?? ""))
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported boolean operator");
        for (const arg of asArray(body.args)) expression(arg, scope, clause);
        return;
      case "NullTest":
      case "BooleanTest":
        expression(body.arg, scope, clause);
        return;
      case "FuncCall":
        functionCall(body, scope, clause);
        return;
      case "SQLValueFunction":
        if (!ALLOWED_SQL_VALUE_FUNCTIONS.has(asString(body.op) ?? "")) {
          fail(
            SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED,
            "Only CURRENT_DATE, CURRENT_TIMESTAMP and LOCALTIMESTAMP are allowed",
          );
        }
        return;
      case "CaseExpr":
        if (body.arg !== undefined) expression(body.arg, scope, clause);
        for (const when of asArray(body.args)) {
          const caseWhen = nodeOf(when);
          if (caseWhen?.[0] !== "CaseWhen") fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Malformed CASE");
          expression(caseWhen[1].expr, scope, clause);
          expression(caseWhen[1].result, scope, clause);
        }
        if (body.defresult !== undefined) expression(body.defresult, scope, clause);
        return;
      case "CoalesceExpr":
      case "MinMaxExpr":
        for (const arg of asArray(body.args)) expression(arg, scope, clause);
        return;
      case "SubLink": {
        if (!policy.allowSubqueries) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Subqueries are not allowed");
        if (!SUBLINK_TYPES.has(asString(body.subLinkType) ?? ""))
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Only EXISTS, IN and scalar subqueries are allowed");
        if (
          body.subLinkType === "ANY_SUBLINK" &&
          asArray(body.operName).length > 0 &&
          stringList(body.operName)?.join(".") !== "="
        ) {
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Only IN (subquery) is allowed");
        }
        if (body.testexpr !== undefined) expression(body.testexpr, scope, clause);
        const sub = nodeOf(body.subselect);
        if (sub?.[0] !== "SelectStmt") fail(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "A subquery must be a SELECT");
        selectStmt(sub[1], scope, false, false);
        return;
      }
      default:
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `${short(type)} is not allowed`);
    }
  }

  function operatorExpression(body, scope, clause) {
    const kind = asString(body.kind) ?? "";
    const names = stringList(body.name);
    if (names?.length !== 1) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Schema-qualified operators are not allowed");
    const operator = names[0] ?? "";
    const left = body.lexpr;
    const right = body.rexpr;

    const columnOf = (value) => (nodeOf(value)?.[0] === "ColumnRef" ? columnRef(value, scope, clause) : null);

    switch (kind) {
      case "AEXPR_OP": {
        if (!COMPARISON_OPERATORS.has(operator) && !ARITHMETIC_OPERATORS.has(operator) && !LIKE_OPERATORS.has(operator)) {
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `Operator ${short(operator)} is not allowed`);
        }
        if (left !== undefined) expression(left, scope, clause);
        expression(right, scope, clause);
        if (COMPARISON_OPERATORS.has(operator) || LIKE_OPERATORS.has(operator)) {
          const leftColumn = left === undefined ? null : columnOf(left);
          const rightColumn = columnOf(right);
          if (leftColumn !== null)
            comparedLiteral(right, LIKE_OPERATORS.has(operator) ? { ...leftColumn, allowedValues: null } : leftColumn, operator);
          if (rightColumn !== null && left !== undefined) comparedLiteral(left, rightColumn, operator);
        }
        return;
      }
      case "AEXPR_IN": {
        if (operator !== "=" && operator !== "<>") fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported IN operator");
        expression(left, scope, clause);
        const items = asArray(asObject(nodeOf(right)?.[1])?.items);
        if (nodeOf(right)?.[0] !== "List" || items.length === 0 || items.length > 100)
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "IN needs a list of 1-100 values");
        const column = columnOf(left);
        for (const item of items) {
          expression(item, scope, clause);
          if (column !== null) comparedLiteral(item, column, "=");
        }
        return;
      }
      case "AEXPR_LIKE":
      case "AEXPR_ILIKE": {
        expression(left, scope, clause);
        expression(right, scope, clause);
        const column = columnOf(left);
        if (column !== null) comparedLiteral(right, { ...column, allowedValues: null }, "~~");
        return;
      }
      case "AEXPR_BETWEEN":
      case "AEXPR_NOT_BETWEEN": {
        expression(left, scope, clause);
        const bounds = asArray(asObject(nodeOf(right)?.[1])?.items);
        if (bounds.length !== 2) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "BETWEEN needs two bounds");
        const column = columnOf(left);
        for (const bound of bounds) {
          expression(bound, scope, clause);
          if (column !== null) comparedLiteral(bound, column, "<=");
        }
        return;
      }
      case "AEXPR_NULLIF":
      case "AEXPR_DISTINCT":
      case "AEXPR_NOT_DISTINCT":
        expression(left, scope, clause);
        expression(right, scope, clause);
        return;
      default:
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `${short(kind)} expressions are not allowed`);
    }
  }

  function functionCall(body, scope, clause) {
    const names = stringList(body.funcname);
    if (names === undefined || names.length === 0) fail(SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED, "Unsupported function call");
    // pg_catalog.* only appears for SQL-syntax forms the parser itself produces: EXTRACT, AT TIME ZONE, TRIM.
    const sqlSyntax = body.funcformat === "COERCE_SQL_SYNTAX" && names.length === 2 && names[0] === "pg_catalog";
    if (names.length !== 1 && !sqlSyntax)
      fail(SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED, "Schema-qualified functions are not allowed");
    const name = (names[names.length - 1] ?? "").toLowerCase();
    if (!policy.functions.has(name)) fail(SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED, `Function ${short(name)} is not allowed`);
    if (body.agg_within_group === true || body.func_variadic === true)
      fail(SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED, "WITHIN GROUP and VARIADIC are not allowed");
    if (body.agg_star === true && name !== "count") fail(SqlValidationCodes.SQL_FUNCTION_NOT_ALLOWED, "Only count(*) may use *");
    if (body.over !== undefined) {
      if (!policy.allowWindowFunctions) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Window functions are not allowed");
      const over = asObject(body.over) ?? nodeOf(body.over)?.[1] ?? {};
      if (over.refname !== undefined || over.name !== undefined)
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Named windows are not allowed");
      for (const part of asArray(over.partitionClause)) expression(part, scope, clause);
      for (const order of asArray(over.orderClause)) sortBy(order, scope, null);
    }
    for (const arg of asArray(body.args)) expression(arg, scope, clause);
    for (const order of asArray(body.agg_order)) sortBy(order, scope, null);
    if (body.agg_filter !== undefined) expression(body.agg_filter, scope, clause);
  }

  function sortBy(value, scope, outputs, targetCount = 0) {
    const node = nodeOf(value);
    if (node?.[0] !== "SortBy") fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported ORDER BY item");
    if (asArray(node[1].useOp).length > 0) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "ORDER BY USING is not allowed");
    const key = node[1].node;
    const ordinal = integerConst(key);
    if (ordinal !== undefined && outputs !== null) {
      if (ordinal < 1 || ordinal > targetCount)
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "ORDER BY position is out of range");
      return;
    }
    // A bare name in ORDER BY refers to an output column first (PostgreSQL's rule); anything else is an input expression.
    const ref = nodeOf(key);
    const fields = ref?.[0] === "ColumnRef" ? stringList(ref[1].fields) : undefined;
    if (outputs !== null && fields?.length === 1 && outputs.has(fields[0] ?? "")) return;
    expression(key, scope, "ORDER BY");
  }

  // ── SELECT ────────────────────────────────────────────────────────────────
  function outputName(target) {
    const name = asString(target.name);
    if (name !== undefined) return name;
    const node = nodeOf(target.val);
    if (node?.[0] === "ColumnRef") return stringList(node[1].fields)?.at(-1);
    if (node?.[0] === "FuncCall") return stringList(node[1].funcname)?.at(-1);
    return undefined;
  }

  function limitValue(value, what, max) {
    if (value === undefined) return undefined;
    const number = integerConst(value);
    if (number === undefined || number < 0 || number > max)
      fail(SqlValidationCodes.SQL_LIMIT_INVALID, `${what} must be a whole number from 0 to ${String(max)}`);
    return number;
  }

  /**
   * Checks one SELECT and returns its output column names. `parent` is the enclosing scope (outer FROM
   * sources and WITH names). `top` marks the statement whose output is returned (aggregation rule);
   * `outermost` the one whose LIMIT is enforced.
   */
  function selectStmt(body, parent, top, outermost) {
    if (body.intoClause !== undefined) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "SELECT INTO is not allowed");
    if (asArray(body.lockingClause).length > 0)
      fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "FOR UPDATE / FOR SHARE are not allowed");
    if (asArray(body.valuesLists).length > 0) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "VALUES lists are not allowed");
    if (asArray(body.windowClause).length > 0) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "WINDOW clauses are not allowed");
    if (body.limitOption === "LIMIT_OPTION_WITH_TIES")
      fail(SqlValidationCodes.SQL_LIMIT_INVALID, "FETCH ... WITH TIES is not allowed");

    const scope = { sources: new Map(), ctes: new Map(), parent };

    const withClause = asObject(body.withClause) ?? nodeOf(body.withClause)?.[1];
    if (withClause !== undefined) {
      if (withClause.recursive === true) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "WITH RECURSIVE is not allowed");
      for (const entry of asArray(withClause.ctes)) {
        const cte = nodeOf(entry);
        if (cte?.[0] !== "CommonTableExpr") fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Malformed WITH");
        const query = nodeOf(cte[1].ctequery);
        if (query?.[0] !== "SelectStmt") fail(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "WITH may only contain SELECT queries");
        const name = asString(cte[1].ctename) ?? "";
        // A WITH name may not reuse an allowed table's name: applications can then safely provide that
        // table themselves as a CTE (a "virtual table") placed in front of the validated statement.
        if (policy.tables.has(name))
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `WITH name "${short(name)}" is the name of a table`);
        if (scope.ctes.has(name)) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, `WITH name "${short(name)}" is used twice`);
        // A WITH query sees the WITH queries before it and the enclosing scope (its FROM is not filled yet).
        const outputs = selectStmt(query[1], scope, false, false);
        const renamed = stringList(cte[1].aliascolnames);
        scope.ctes.set(name, renamed !== undefined && renamed.length > 0 ? new Set(renamed) : outputs);
      }
    }

    const op = asString(body.op) ?? "SETOP_NONE";
    if (op !== "SETOP_NONE") {
      if (!policy.allowSetOperations)
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "UNION, INTERSECT and EXCEPT are not allowed");
      // Set-operation branches are SelectStmt bodies without the usual { SelectStmt: ... } wrapper.
      const left = asObject(body.larg);
      const right = asObject(body.rarg);
      if (typeof left?.op !== "string" || typeof right?.op !== "string")
        fail(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "Set operations must combine SELECTs");
      const outputs = selectStmt(left, scope, top, false);
      selectStmt(right, scope, top, false);
      for (const order of asArray(body.sortClause)) sortBy(order, scope, outputs, outputs.size);
      finishLimits(body, outermost);
      return outputs;
    }

    const from = asArray(body.fromClause);
    if (from.length > 1) fail(SqlValidationCodes.SQL_JOIN_NOT_ALLOWED, "Comma joins are not allowed; use JOIN ... ON");
    for (const item of from) fromItem(item, scope);

    const targets = asArray(body.targetList);
    if (targets.length === 0) fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "SELECT needs at least one output column");
    const outputs = new Set();
    for (const target of targets) {
      const resTarget = nodeOf(target);
      if (resTarget?.[0] !== "ResTarget") fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Unsupported output column");
      expression(resTarget[1].val, scope, "SELECT");
      const name = outputName(resTarget[1]);
      if (name !== undefined) outputs.add(name);
    }
    if (body.whereClause !== undefined) expression(body.whereClause, scope, "WHERE");
    for (const group of asArray(body.groupClause)) {
      const ordinal = integerConst(group);
      if (ordinal !== undefined) {
        if (ordinal < 1 || ordinal > targets.length)
          fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "GROUP BY position is out of range");
        continue;
      }
      if (nodeOf(group)?.[0] === "GroupingSet")
        fail(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "ROLLUP, CUBE and GROUPING SETS are not allowed");
      // PostgreSQL resolves a bare GROUP BY name to an input column before an output name, so an output
      // name here could silently mean a hidden column. Ask for the position instead.
      const groupNode = nodeOf(group);
      const groupFields = groupNode?.[0] === "ColumnRef" ? stringList(groupNode[1].fields) : undefined;
      const groupName = groupFields?.length === 1 ? (groupFields[0] ?? "") : undefined;
      if (
        groupName !== undefined &&
        outputs.has(groupName) &&
        ![...scope.sources.values()].some((source) => source.columns.has(groupName))
      ) {
        fail(
          SqlValidationCodes.SQL_COLUMN_NOT_ALLOWED,
          `GROUP BY cannot use the output name "${short(groupName)}"; use its position (GROUP BY 1) or repeat the expression`,
        );
      }
      expression(group, scope, "GROUP BY");
    }
    if (body.havingClause !== undefined) expression(body.havingClause, scope, "HAVING");
    for (const distinct of asArray(body.distinctClause)) {
      // Plain DISTINCT is an empty node; DISTINCT ON lists expressions.
      if (Object.keys(asObject(distinct) ?? {}).length > 0) expression(distinct, scope, "DISTINCT ON");
    }
    for (const order of asArray(body.sortClause)) sortBy(order, scope, outputs, targets.length);
    finishLimits(body, outermost);
    if (top && policy.requireAggregation) checkAggregation(body);
    return outputs;
  }

  let topLimit = null;
  function finishLimits(body, outermost) {
    const count = limitValue(body.limitCount, "LIMIT", Number.MAX_SAFE_INTEGER);
    limitValue(body.limitOffset, "OFFSET", policy.maxOffset);
    if (outermost && count !== undefined) topLimit = { value: count, location: locationOf(nodeOf(body.limitCount)?.[1] ?? {}) };
  }

  // ── Aggregation ───────────────────────────────────────────────────────────
  function containsAggregate(value) {
    const node = nodeOf(value);
    if (node?.[0] === "FuncCall") {
      const name = (stringList(node[1].funcname)?.at(-1) ?? "").toLowerCase();
      if (policy.aggregates.has(name) && node[1].over === undefined) return true;
    }
    if (node?.[0] === "SubLink") return false;
    const object = asObject(value);
    const children =
      node !== undefined
        ? Object.values(node[1])
        : Array.isArray(value)
          ? asArray(value)
          : object !== undefined
            ? Object.values(object)
            : [];
    return children.some((child) => typeof child === "object" && child !== null && containsAggregate(child));
  }

  /** Every output column must be an aggregate or a GROUP BY key, so no individual rows are returned. */
  function checkAggregation(body) {
    const groups = asArray(body.groupClause);
    const groupKeys = new Set(groups.map(structuralKey));
    const groupOrdinals = new Set(groups.map(integerConst).filter((n) => n !== undefined));
    asArray(body.targetList).forEach((target, index) => {
      const value = nodeOf(target)?.[1].val;
      if (containsAggregate(value) || groupKeys.has(structuralKey(value)) || groupOrdinals.has(index + 1)) return;
      fail(SqlValidationCodes.SQL_AGGREGATION_REQUIRED, "Every output column must be an aggregate or a GROUP BY key");
    });
  }

  selectStmt(select, null, true, true);
  return { tables, columns, literals, paramRefs, topLimit };
}
