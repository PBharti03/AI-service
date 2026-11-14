// Every shared setting of @b2y/ai-service in one place (dependency-free, so the UI can import it too).
import { DATA_CLASSIFICATION, PROVIDER_TYPE } from "./Enums.js";

// ── Assistant identity and access ────────────────────────────────────────────

/** The assistant's name in every application. */
export const ASSISTANT_NAME = "Beya";

/** The standard permission that lets a role use the AI assistant in any B2Y application. */
export const AI_ASSISTANT_PERMISSION = "AI Assistant:Use AI Assistant";

/** Most role permissions or plan features one request may carry. */
export const MAX_GRANTS = 1000;

// ── Provider and model: the only place that picks them for every application ─

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_TIMEOUT_MS = 60_000;
/** The model the package's tasks are tuned for. */
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
/** Paid providers are only called on these hosts. */
export const APPROVED_PAID_HOSTS = Object.freeze(["api.groq.com"]);
export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The provider and model every B2Y application uses. Applications never name one: to switch provider or
 * model, change this and release the package.
 */
export const AI_PROVIDER_CONFIG = Object.freeze({
  type: PROVIDER_TYPE.GROQ,
  model: GROQ_DEFAULT_MODEL,
  allowedClassifications: Object.freeze([DATA_CLASSIFICATION.INTERNAL]),
  paid: true,
  invalidOutputRetries: 1,
});

/** Longest the service refuses calls after a provider rate limit, and the wait without a Retry-After (ms). */
export const RATE_LIMIT_COOLDOWN_MAX_MS = 60_000;
export const RATE_LIMIT_COOLDOWN_UNKNOWN_MS = 5_000;
export const MAX_OUTPUT_CHARS = 100_000;

// ── Assistant replies and conversations ──────────────────────────────────────

export const MAX_MESSAGE_CHARS = 4000;
export const ASSISTANT_TIMEOUT_MS = 60_000;
export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 14;
export const APP_DATA_MAX_BYTES = 65_536;
export const CONVERSATION_LIST_LIMIT = 20;

// ── Analytics and documents ──────────────────────────────────────────────────

export const MAX_QUESTION_CHARS = 2000;
/** Independent queries one question may need. */
export const MAX_PLAN_QUERIES = 4;
/** Earlier analytics turns a follow-up may refer to. */
export const MAX_PLAN_CONVERSATION_TURNS = 3;
/** Upper bounds per question; an application may set lower ones, never higher. */
export const ANALYTICS_LIMITS = Object.freeze({ maxQueries: MAX_PLAN_QUERIES, maxTotalRows: 600, timeoutMs: 15_000 });
export const STATEMENT_TIMEOUT_MS = 5000;
export const MAX_PASSAGE_CHARS = 1500;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT_CHARS = 2_000_000;

// ── HTTP API ─────────────────────────────────────────────────────────────────

/** The assistant API paths every application serves (mountAssistantRoutes) and the UI client calls. */
export const ASSISTANT_PATHS = Object.freeze({ status: "/ai/status", chat: "/ai/chat", conversations: "/ai/conversations" });

export const HTTP_STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, TOO_MANY: 429, BAD_GATEWAY: 502 });

// ── Messages (an application may override the endpoint messages, for example translated) ─

/** Shown to users on a rate limit; the provider's wait belongs in logs (rateLimitInfo). */
export const AI_BUSY_MESSAGE = "AI is temporarily busy. Please try again shortly.";

export const AI_MESSAGES = Object.freeze({
  NOT_AVAILABLE: "The AI assistant is not available here.",
  NOT_PERMITTED: "You do not have access to the AI assistant.",
  MESSAGE_TOO_LONG: "Please write a shorter message.",
  TOO_MANY_MESSAGES: "You're sending messages quickly. Please wait a moment and try again.",
  NOT_ANSWERED: "The assistant could not answer this time. Please try again.",
  ANSWERED: "Answer generated",
});

// ── Chat UI ──────────────────────────────────────────────────────────────────

/** Phone widths: the page layout's chat list becomes a drawer. Matches the page styles' breakpoint. */
export const PHONE_MEDIA_QUERY = "(max-width: 767px)";
/** Small screens: the floating widget's panel fills the screen. Matches the widget styles' breakpoint. */
export const COMPACT_MEDIA_QUERY = "(max-width: 640px)";

/** Default chat UI text; applications pass translated labels to override any of them. */
export const UI_LABELS = Object.freeze({
  title: ASSISTANT_NAME,
  greeting: "How can I help you today?",
  subtitle: "Ask anything: questions about your data, advice or general topics.",
  placeholder: "Ask a question",
  send: "Send",
  retry: "Try again",
  newChat: "New chat",
  history: "Recent chats",
  noHistory: "No recent chats",
  loading: "Loading your conversation",
  error: "The assistant could not answer. Please try again.",
  typing: `${ASSISTANT_NAME} is typing`,
  hint: "Enter to send, Shift + Enter for a new line",
  untitled: "Conversation",
  truncated: "Showing the first rows.",
  sources: "Sources",
  recent: "Recent",
  toggleSidebar: "Show or hide chats",
  launcher: `Ask ${ASSISTANT_NAME}`,
  close: "Close",
});
