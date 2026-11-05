import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseTrustedContext } from "../context/TrustedContext.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { responseBlocksSchema } from "../copilot/ResponseBlocks.js";

/**
 * Conversation history for the assistant, scoped to one application, tenant and user. The scope always
 * comes from the trusted context, never from the client: a conversation id from another user or tenant
 * simply finds nothing. Assistant messages built from application data are stored for the user but are
 * never shown to the model again (modelVisible false). No credentials, tokens or context grants are
 * stored: only the scope ids, the message text and blocks, and a little metadata.
 */

export const DEFAULT_RETENTION_DAYS = 14;
export const MAX_RETENTION_DAYS = 14;
const MIN_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const conversationMessageSchema = z.strictObject({
  messageId: z.string().regex(CONVERSATION_ID),
  conversationId: z.string().regex(CONVERSATION_ID),
  applicationId: z.string().min(1).max(64),
  tenantId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(6000),
  blocks: responseBlocksSchema.default([]),
  route: z.string().max(64).nullable().default(null),
  status: z.string().max(32).nullable().default(null),
  modelVisible: z.boolean(),
  // The application's own display data for this message (for example its reply object), JSON only and at
  // most APP_DATA_MAX_BYTES. Kept for the application's server; never shown to the model.
  appData: z.json().optional(),
  createdAt: z.iso.datetime(),
});
export const APP_DATA_MAX_BYTES = 65_536;

const STORE_METHODS = ["appendMessage", "listMessages", "listConversations", "deleteConversation", "deleteInactiveSince"];
const stores = new WeakSet();

/**
 * Wraps a consumer's storage. Each method gets the scope { applicationId, tenantId, userId } and must
 * return only that scope's records; the history manager checks the scope of everything returned again.
 *   appendMessage(message)                                 store one message (and bump the conversation's activity)
 *   listMessages({ scope, conversationId, limit })         messages, oldest first
 *   listConversations({ scope, limit })                    [{ conversationId, title, updatedAt }], newest first
 *   deleteConversation({ scope, conversationId })          -> boolean
 *   deleteInactiveSince({ cutoff })                        delete conversations whose last message is older -> count
 */
export function defineConversationStore(definition) {
  const missing = STORE_METHODS.filter((name) => typeof definition?.[name] !== "function");
  if (missing.length > 0) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A conversation store needs appendMessage, listMessages, listConversations, deleteConversation and deleteInactiveSince", { details: { missing: missing.join(",") } });
  const store = Object.freeze(Object.fromEntries(STORE_METHODS.map((name) => [name, definition[name]])));
  stores.add(store);
  return store;
}

export function isConversationStore(value) {
  return typeof value === "object" && value !== null && stores.has(value);
}

const sameScope = (record, scope) => record.applicationId === scope.applicationId && record.tenantId === scope.tenantId && record.userId === scope.userId;

/** In-process store: for tests, development and single-instance deployments (lost on restart). */
export function createMemoryConversationStore() {
  const conversations = new Map();
  return defineConversationStore({
    async appendMessage(message) {
      const entry = conversations.get(message.conversationId) ?? { scope: { applicationId: message.applicationId, tenantId: message.tenantId, userId: message.userId }, messages: [], updatedAt: message.createdAt };
      if (!sameScope(message, entry.scope)) throw new AiServiceError(ErrorCodes.NOT_AUTHORIZED, "The conversation belongs to another user");
      entry.messages.push(structuredClone(message));
      entry.updatedAt = message.createdAt;
      conversations.set(message.conversationId, entry);
    },
    async listMessages({ scope, conversationId, limit }) {
      const entry = conversations.get(conversationId);
      if (!entry || !sameScope(entry.scope, scope)) return [];
      return entry.messages.slice(-limit).map((message) => structuredClone(message));
    },
    async listConversations({ scope, limit }) {
      return [...conversations.entries()]
        .filter(([, entry]) => sameScope(entry.scope, scope))
        .sort(([, a], [, b]) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit)
        .map(([conversationId, entry]) => ({ conversationId, title: (entry.messages.find((message) => message.role === "user")?.text ?? "").slice(0, 80), updatedAt: entry.updatedAt }));
    },
    async deleteConversation({ scope, conversationId }) {
      const entry = conversations.get(conversationId);
      if (!entry || !sameScope(entry.scope, scope)) return false;
      return conversations.delete(conversationId);
    },
    async deleteInactiveSince({ cutoff }) {
      let deleted = 0;
      for (const [conversationId, entry] of conversations) {
        if (entry.updatedAt < cutoff) {
          conversations.delete(conversationId);
          deleted += 1;
        }
      }
      return deleted;
    },
  });
}

/** Plain text of reply blocks, for history (tables and charts are left out). */
export function blocksToText(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "paragraph" || block.type === "heading") return block.text;
      if (block.type === "bullets") return block.items.map((item) => `- ${item}`).join("\n");
      if (block.type === "metrics") return block.items.map((item) => `${item.label}: ${item.value}`).join("; ");
      if (block.type === "notice") return block.items.join(" ");
      return "";
    })
    .filter((part) => part !== "")
    .join("\n")
    .slice(0, 6000);
}

const PLACEHOLDER = "[An earlier answer based on application data, not shown here.]";

/**
 * @param {{ store: ReturnType<typeof defineConversationStore>, retentionDays?: number, maxModelMessages?: number, now?: () => Date }} options
 */
export function createConversationHistory({ store, retentionDays = DEFAULT_RETENTION_DAYS, maxModelMessages = 6, now = () => new Date() }) {
  if (!isConversationStore(store)) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createConversationHistory needs a store from defineConversationStore()");
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, `retentionDays must be a whole number of days from ${String(MIN_RETENTION_DAYS)} to ${String(MAX_RETENTION_DAYS)}`);
  }
  if (!Number.isInteger(maxModelMessages) || maxModelMessages < 0 || maxModelMessages > 8) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "maxModelMessages must be 0-8");

  const scopeOf = (context) => {
    const parsed = parseTrustedContext(context);
    return { applicationId: parsed.applicationId, tenantId: parsed.tenantId, userId: parsed.actor.userId };
  };
  const cutoff = () => new Date(now().getTime() - retentionDays * DAY_MS).toISOString();
  const validConversationId = (id) => typeof id === "string" && CONVERSATION_ID.test(id);

  /** The scope's messages of one conversation, oldest first; expired or foreign records are dropped. */
  async function load({ context, conversationId, limit = 50 }) {
    if (!validConversationId(conversationId)) return [];
    const scope = scopeOf(context);
    const records = await store.listMessages({ scope, conversationId, limit: Math.min(Math.max(1, limit), 200) });
    const oldest = cutoff();
    const messages = [];
    for (const record of Array.isArray(records) ? records : []) {
      const parsed = conversationMessageSchema.safeParse(record);
      if (!parsed.success || !sameScope(parsed.data, scope) || parsed.data.conversationId !== conversationId) continue;
      messages.push(parsed.data);
    }
    // A conversation whose last activity is older than the retention period is treated as gone.
    if (messages.length > 0 && messages[messages.length - 1].createdAt < oldest) return [];
    return messages;
  }

  async function append({ context, conversationId, role, text, blocks = [], route = null, status = null, modelVisible, appData }) {
    const scope = scopeOf(context);
    if (!validConversationId(conversationId)) throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Invalid conversation id");
    if (appData !== undefined && Buffer.byteLength(JSON.stringify(appData) ?? "", "utf8") > APP_DATA_MAX_BYTES) throw new AiServiceError(ErrorCodes.INPUT_INVALID, "appData is too large", { details: { maxBytes: APP_DATA_MAX_BYTES } });
    const message = conversationMessageSchema.parse({ messageId: randomUUID(), conversationId, ...scope, role, text: String(text).slice(0, 6000), blocks, route, status, modelVisible, ...(appData === undefined ? {} : { appData }), createdAt: now().toISOString() });
    await store.appendMessage(message);
    return message;
  }

  /** Recent messages as the model may see them: data-based answers replaced by a placeholder. */
  function forModel(messages) {
    return messages
      .slice(-maxModelMessages)
      .map((message) => ({ role: message.role, text: (message.role === "assistant" && !message.modelVisible ? PLACEHOLDER : message.text).slice(0, 2000) }))
      .filter((message) => message.text.trim() !== "");
  }

  return Object.freeze({
    retentionDays,
    newConversationId: () => randomUUID(),
    isConversationId: validConversationId,
    load,
    append,
    forModel,
    list: async ({ context, limit = 20 }) => {
      const scope = scopeOf(context);
      const rows = await store.listConversations({ scope, limit: Math.min(Math.max(1, limit), 100) });
      return (Array.isArray(rows) ? rows : []).filter((row) => validConversationId(row?.conversationId) && row.updatedAt >= cutoff()).map((row) => ({ conversationId: row.conversationId, title: String(row.title ?? "").slice(0, 80), updatedAt: row.updatedAt }));
    },
    remove: ({ context, conversationId }) => (validConversationId(conversationId) ? store.deleteConversation({ scope: scopeOf(context), conversationId }) : false),
    /** Deletes every conversation inactive for longer than the retention period. Schedule it daily. */
    cleanupExpiredConversations: async () => ({ deleted: Number(await store.deleteInactiveSince({ cutoff: cutoff() })) || 0, cutoff: cutoff() }),
  });
}

/**
 * Optional helper for applications without a scheduler: runs cleanup now and then every intervalMs, on
 * an unref'd timer (it never keeps the process alive). Returns { stop }. Applications with cron should
 * call history.cleanupExpiredConversations() from their own job instead.
 */
export function scheduleConversationCleanup({ history, intervalMs = 6 * 3_600_000, onResult, onError } = {}) {
  if (typeof history?.cleanupExpiredConversations !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "scheduleConversationCleanup needs a conversation history");
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "intervalMs must be at least one minute");
  const run = () =>
    history.cleanupExpiredConversations().then(
      (result) => onResult?.(result),
      (error) => onError?.(error),
    );
  run();
  const timer = globalThis.setInterval(run, intervalMs);
  timer.unref?.();
  return Object.freeze({ stop: () => globalThis.clearInterval(timer) });
}
