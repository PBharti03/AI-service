export const MAX_QUESTION_CHARS = 2000;
export const MAX_PLAN_QUERIES = 4;
export const MAX_PLAN_CONVERSATION_TURNS = 3;
/** Upper bounds per question; an application may set lower ones, never higher. */
export const ANALYTICS_LIMITS = Object.freeze({ maxQueries: MAX_PLAN_QUERIES, maxTotalRows: 600, timeoutMs: 15_000 });
export const STATEMENT_TIMEOUT_MS = 5000;
