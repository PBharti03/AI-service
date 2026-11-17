// Server-side building blocks every application uses the same way: the AI runtime (service and chat history),
// ready-made HTTP endpoints with one error policy, a rate limiter, and read-only SQL execution.
import { createDefaultAiService } from "../core/AiService.js";
import { aiUserMessage, AiServiceError, errorCategory, ErrorCategories, isRateLimited, rateLimitInfo } from "../core/Errors.js";
import { createConversationHistory, scheduleConversationCleanup } from "../conversations/ConversationHistory.js";
import { createFolderConversationStore } from "../conversations/FolderConversationStore.js";
import { STATEMENT_TIMEOUT_MS } from "../constants/AnalyticsConstants.js";
import { CONVERSATION_LIST_LIMIT } from "../constants/ConversationConstants.js";
import { AI_MESSAGES, HTTP_STATUS, RATE_LIMIT_DEFAULTS, RESPONSE_STATUS } from "../constants/ServerConstants.js";
export { AI_MESSAGES, RESPONSE_STATUS } from "../constants/ServerConstants.js";

const noop = () => {};
const quietLogger = Object.freeze({ info: noop, warn: noop, error: noop });

/**
 * The AI service and server-side chat history for an application, from its configuration. Without an API key
 * the assistant is off (ai is null); without a folder, chats are not kept.
 * @param {{ apiKey?: string, tasks: readonly object[], conversationsDir?: string, retentionDays?: number, logger?: object }} options
 */
export function createAiRuntime({ apiKey, tasks, conversationsDir, retentionDays, logger = quietLogger }) {
  if (!apiKey) return Object.freeze({ ai: null, history: null });
  const ai = createDefaultAiService({ apiKey, tasks });
  let history = null;
  if (conversationsDir) {
    history = createConversationHistory({ store: createFolderConversationStore({ root: conversationsDir }), ...(retentionDays ? { retentionDays } : {}) });
    scheduleConversationCleanup({ history, onError: (error) => logger.warn("AI conversation cleanup failed", { code: error?.code || error?.name }) });
  }
  return Object.freeze({ ai, history });
}

/**
 * Fixed-window limits in memory (one server instance): per user and per tenant. Keys come from the trusted
 * context, so a user cannot reset them.
 * @param {{ perUser?: number, perUserWindowMs?: number, perTenant?: number, perTenantWindowMs?: number, now?: () => number }} options
 */
export function createRateLimiter({ perUser = RATE_LIMIT_DEFAULTS.perUser, perUserWindowMs = RATE_LIMIT_DEFAULTS.perUserWindowMs, perTenant = RATE_LIMIT_DEFAULTS.perTenant, perTenantWindowMs = RATE_LIMIT_DEFAULTS.perTenantWindowMs, now = () => Date.now() } = {}) {
  const windows = new Map();
  const hit = (key, limit, windowMs) => {
    const at = now();
    const entry = windows.get(key);
    if (!entry || at - entry.start >= windowMs) {
      windows.set(key, { start: at, count: 1 });
      return { ok: true };
    }
    if (entry.count >= limit) return { ok: false, retryAfterSeconds: Math.ceil((entry.start + windowMs - at) / 1000) };
    entry.count += 1;
    return { ok: true };
  };
  const sweep = globalThis.setInterval(() => {
    const at = now();
    for (const [key, entry] of windows) if (at - entry.start > Math.max(perUserWindowMs, perTenantWindowMs)) windows.delete(key);
  }, perUserWindowMs);
  sweep.unref?.();
  return Object.freeze({
    take({ tenantId, userId }) {
      const user = hit(`u:${tenantId}:${userId}`, perUser, perUserWindowMs);
      return user.ok ? hit(`t:${tenantId}`, perTenant, perTenantWindowMs) : user;
    },
  });
}

/**
 * Runs one statement in a READ ONLY transaction with a statement timeout (Sequelize or any client with the
 * same transaction/query API). Values only through bind ($1) or named replacements (:name).
 * @returns {Promise<{ rows: object[], fields: string[] }>}
 */
export async function runReadOnly(sequelize, sql, { bind, replacements, timeoutMs = STATEMENT_TIMEOUT_MS } = {}) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SET TRANSACTION READ ONLY", { transaction });
    await sequelize.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`, { transaction });
    const [rows, result] = await sequelize.query(sql, { ...(bind ? { bind } : {}), ...(replacements ? { replacements } : {}), transaction, type: "RAW" });
    const fields = Array.isArray(result?.fields) ? result.fields.map((field) => String(field.name)) : rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, fields };
  });
}

/** Quoted, schema-qualified table names for the given Sequelize models: { key: model }. */
export function quoteTables(sequelize, models) {
  const generator = sequelize.getQueryInterface().queryGenerator;
  return Object.freeze(Object.fromEntries(Object.entries(models).map(([key, model]) => [key, generator.quoteTable(model.getTableName())])));
}

/** Express-style JSON reply in the B2Y shape { status, message, data }. */
const defaultRespond = (res, httpStatus, ok, message, data) => res.status(httpStatus).json({ status: ok ? RESPONSE_STATUS.SUCCESS : RESPONSE_STATUS.FAILURE, ...(message ? { message } : {}), ...(data !== undefined ? { data } : {}) });

/**
 * The assistant's HTTP endpoints with one error policy for every application. resolve(req) returns
 * { assistant, context } for a signed-in user, or null when the assistant is not available (not configured,
 * or not in the plan); it may throw accessDenied(...) or a package authorization error.
 * @param {{ resolve: (req: object) => Promise<{ assistant: object, context: object } | null>, limiter?: object, logger?: object,
 *   messages?: Partial<typeof AI_MESSAGES>, respond?: Function }} options
 */
export function createAssistantEndpoints({ resolve, limiter = createRateLimiter(), logger = quietLogger, messages = {}, respond = defaultRespond }) {
  if (typeof resolve !== "function") throw new TypeError("createAssistantEndpoints needs resolve(req)");
  const text = { ...AI_MESSAGES, ...messages };
  const fail = (res, error, what) => {
    if (isRateLimited(error)) {
      logger.warn(`${what} rate limited`, rateLimitInfo(error));
      return respond(res, HTTP_STATUS.TOO_MANY, false, aiUserMessage(error), { rateLimited: true });
    }
    const category = error instanceof AiServiceError ? errorCategory(error) : null;
    if (category === ErrorCategories.NOT_AUTHORIZED) {
      logger.warn(`${what} refused`, { code: error.code });
      return respond(res, HTTP_STATUS.FORBIDDEN, false, text.NOT_PERMITTED);
    }
    if (category === ErrorCategories.INPUT_INVALID) return respond(res, HTTP_STATUS.BAD_REQUEST, false, text.MESSAGE_TOO_LONG);
    logger.warn(`${what} failed`, { code: error?.code || error?.name });
    return respond(res, HTTP_STATUS.BAD_GATEWAY, false, text.NOT_ANSWERED);
  };
  const handle = (what, run) => async (req, res) => {
    try {
      return await run(req, res);
    } catch (error) {
      return fail(res, error, what);
    }
  };
  return Object.freeze({
    /** Whether the assistant is available to this user (the UI shows it only then). */
    status: handle("AI status", async (req, res) => respond(res, HTTP_STATUS.OK, true, null, { enabled: Boolean(await resolve(req).catch(() => null)) })),
    chat: handle("AI chat", async (req, res) => {
      const ready = await resolve(req);
      if (!ready) return respond(res, HTTP_STATUS.NOT_FOUND, false, text.NOT_AVAILABLE);
      const allowed = limiter.take({ tenantId: ready.context.tenantId, userId: ready.context.actor.userId });
      if (!allowed.ok) return respond(res, HTTP_STATUS.TOO_MANY, false, text.TOO_MANY_MESSAGES, { rateLimited: true, retryAfterSeconds: allowed.retryAfterSeconds });
      const reply = await ready.assistant.reply({ message: req.body?.message, context: ready.context, conversationId: req.body?.conversationId });
      logger.info("AI chat answered", { route: reply.route, status: reply.status, blocks: reply.blocks.length });
      return respond(res, HTTP_STATUS.OK, true, text.ANSWERED, { conversationId: reply.conversationId, status: reply.status, blocks: reply.blocks });
    }),
    listConversations: handle("AI conversations", async (req, res) => {
      const ready = await resolve(req);
      const conversations = ready?.assistant.hasHistory ? await ready.assistant.listConversations({ context: ready.context, limit: CONVERSATION_LIST_LIMIT }) : [];
      return respond(res, HTTP_STATUS.OK, true, null, { conversations });
    }),
    getConversation: handle("AI conversation", async (req, res) => {
      const ready = await resolve(req);
      const messages = ready?.assistant.hasHistory ? await ready.assistant.loadConversation({ context: ready.context, conversationId: req.params?.id }) : [];
      return respond(res, HTTP_STATUS.OK, true, null, { messages });
    }),
  });
}

/**
 * Registers the endpoints on an Express router (after the application's own authentication middleware): GET
 * {base}/status, POST {base}/chat, GET {base}/conversations, GET {base}/conversations/:id.
 */
export function mountAssistantRoutes(router, endpoints, base = "/ai") {
  router.get(`${base}/status`, endpoints.status);
  router.post(`${base}/chat`, endpoints.chat);
  router.get(`${base}/conversations`, endpoints.listConversations);
  router.get(`${base}/conversations/:id`, endpoints.getConversation);
  return router;
}
