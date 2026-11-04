import { reject, SqlValidationCodes } from "../SqlValidation.js";

/**
 * Checks on the raw text before parsing, for things the parse tree no longer shows:
 *   - comments (-- and slash-star), which can hide text from reviewers and from the appended LIMIT
 *   - dollar quoting and $n parameters (the package adds its own parameters)
 *   - prefixed string literals (E'', U&'', B'', X'', N''), whose escapes make offset-based rewriting unsafe
 *   - a semicolon anywhere except one trailing statement terminator
 *   - control characters other than tab, line feed and carriage return
 * Returns the statement without its trailing semicolon, or a rejection.
 */
export function lexicalCheck(sql, maxChars, allowParams = false) {
  const trimmed = sql.trim();
  if (trimmed === "") return reject(SqlValidationCodes.SQL_EMPTY, "SQL is empty");
  if (trimmed.length > maxChars)
    return reject(SqlValidationCodes.SQL_TOO_LONG, `SQL is longer than ${String(maxChars)} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return reject(SqlValidationCodes.SQL_INVALID_CHARACTERS, "SQL contains control characters");
    }
  }

  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  let state = "code";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    const next = body[index + 1];
    if (state === "string") {
      if (character === "'") {
        if (next === "'") index += 1;
        else state = "code";
      }
      continue;
    }
    if (state === "identifier") {
      if (character === '"') {
        if (next === '"') index += 1;
        else state = "code";
      }
      continue;
    }
    if (character === "'") {
      const before = index > 0 ? (body[index - 1] ?? "") : "";
      if (/[A-Za-z0-9_&]/.test(before)) {
        return reject(
          SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED,
          "Prefixed string literals (E'', U&'', B'', X'') are not allowed",
        );
      }
      state = "string";
    } else if (character === '"') {
      state = "identifier";
    } else if ((character === "-" && next === "-") || (character === "/" && next === "*")) {
      return reject(SqlValidationCodes.SQL_COMMENT_NOT_ALLOWED, "SQL comments are not allowed");
    } else if (character === "$") {
      // Only the package's own rewritten SQL may contain $n, and only as plain parameter numbers.
      if (allowParams && next !== undefined && /[1-9]/.test(next)) {
        while (/[0-9]/.test(body[index + 1] ?? "")) index += 1;
        continue;
      }
      return reject(SqlValidationCodes.SQL_FEATURE_NOT_ALLOWED, "Dollar quoting and $n parameters are not allowed");
    } else if (character === ";") {
      return reject(SqlValidationCodes.SQL_NOT_SINGLE_SELECT, "Only a single statement is allowed");
    } else if (character === "\\") {
      return reject(SqlValidationCodes.SQL_INVALID_CHARACTERS, "Backslashes are only allowed inside string literals");
    }
  }
  if (state !== "code") return reject(SqlValidationCodes.SQL_PARSE_FAILED, "Unterminated string literal or quoted identifier");
  return { ok: true, sql: body };
}
