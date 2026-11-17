export const ASSISTANT_PATHS = Object.freeze({ status: "/ai/status", chat: "/ai/chat", conversations: "/ai/conversations" });

export const HTTP_STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, TOO_MANY: 429, BAD_GATEWAY: 502 });

/** Endpoint messages; an application may override them (for example translated). */
export const AI_MESSAGES = Object.freeze({
  NOT_AVAILABLE: "The AI assistant is not available here.",
  NOT_PERMITTED: "You do not have access to the AI assistant.",
  MESSAGE_TOO_LONG: "Please write a shorter message.",
  TOO_MANY_MESSAGES: "You're sending messages quickly. Please wait a moment and try again.",
  NOT_ANSWERED: "The assistant could not answer this time. Please try again.",
  ANSWERED: "Answer generated",
});

export const RESPONSE_STATUS = Object.freeze({ SUCCESS: "SUCCESS", FAILURE: "FAILURE" });

/** Per server instance; applications may pass their own limits. */
export const RATE_LIMIT_DEFAULTS = Object.freeze({ perUser: 15, perUserWindowMs: 10 * 60 * 1000, perTenant: 500, perTenantWindowMs: 24 * 60 * 60 * 1000 });
