import { DATA_CLASSIFICATION } from "../enums/DataClassification.js";

/**
 * The provider and model every application uses (any OpenAI-compatible API): change it here and release the
 * package. The host must also be in APPROVED_PROVIDER_HOSTS.
 */
export const AI_PROVIDER_CONFIG = Object.freeze({
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
  timeoutMs: 60_000,
  structuredOutput: "json_schema",
  allowedClassifications: Object.freeze([DATA_CLASSIFICATION.INTERNAL]),
  invalidOutputRetries: 1,
});

/** The only hosts the API key may be sent to (HTTPS, default port). */
export const APPROVED_PROVIDER_HOSTS = Object.freeze(["api.groq.com"]);

export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const RATE_LIMIT_COOLDOWN_MAX_MS = 60_000;
export const RATE_LIMIT_COOLDOWN_UNKNOWN_MS = 5_000;
export const MAX_OUTPUT_CHARS = 100_000;
export const AI_BUSY_MESSAGE = "AI is temporarily busy. Please try again shortly.";
