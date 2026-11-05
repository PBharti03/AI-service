import { z } from "zod";
import { dataClassificationSchema } from "../context/DataClassification.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { createOllamaProvider } from "./OllamaProvider.js";
import { createOpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

/**
 * Builds a ChatProvider from configuration, so a consumer changes provider by changing configuration,
 * not code. Every provider-specific detail (endpoint, headers, response format, error mapping) stays
 * behind the ChatProvider interface; consumers only ever call createAiService({ provider }).
 *
 * Fails closed: unknown types, unknown fields, missing keys and invalid values throw CONFIG_INVALID
 * before any request is made. There is no default classification and no fallback provider.
 */

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_TIMEOUT_MS = 60_000;
export const PROVIDER_TYPES = Object.freeze(["groq", "ollama", "openai-compatible"]);
const OLLAMA_KEYS = new Set(["baseUrl", "model", "modelRevision", "timeoutMs", "id", "structuredOutput"]);

const apiKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
const structuredOutputSchema = z.enum(["json_schema", "json_object", "none"]);

const groqConfigSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .default("groq"),
  apiKey: apiKeySchema,
  model: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200).optional(),
  // Required: what may be sent to a paid provider is the consumer's decision, never a default.
  allowedClassifications: z.array(dataClassificationSchema).min(1),
  timeoutMs: z.number().int().min(100).max(600_000).default(GROQ_DEFAULT_TIMEOUT_MS),
  structuredOutput: structuredOutputSchema.default("json_schema"),
  maxRequestBytes: z.number().int().min(1024).max(5_000_000).optional(),
  maxResponseBytes: z.number().int().min(1024).max(10_000_000).optional(),
});

function invalid(error, schema, what) {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, `${what} configuration is invalid`, {
    details: summarizeZodError(error, schema),
  });
}

/**
 * Groq (paid, api.groq.com) through its OpenAI-compatible API. The service using it must also be
 * created with allowPaidProvider: true.
 * @param {{ apiKey: string, model: string, allowedClassifications: DataClassification[], id?: string, modelRevision?: string, timeoutMs?: number, structuredOutput?: StructuredOutputMode, maxRequestBytes?: number, maxResponseBytes?: number }} config
 * @param {{ fetch?: typeof fetch, now?: () => number }} [dependencies]
 * @returns {ChatProvider}
 */
export function createGroqProvider(config, dependencies = {}) {
  const parsed = groqConfigSchema.safeParse(config);
  if (!parsed.success) throw invalid(parsed.error, groqConfigSchema, "Groq provider");
  const settings = parsed.data;
  return createOpenAICompatibleProvider(
    {
      id: settings.id,
      kind: "PAID",
      baseUrl: GROQ_BASE_URL,
      model: settings.model,
      ...(settings.modelRevision === undefined ? {} : { modelRevision: settings.modelRevision }),
      apiKey: settings.apiKey,
      timeoutMs: settings.timeoutMs,
      allowedClassifications: settings.allowedClassifications,
      structuredOutput: settings.structuredOutput,
      ...(settings.maxRequestBytes === undefined ? {} : { maxRequestBytes: settings.maxRequestBytes }),
      ...(settings.maxResponseBytes === undefined ? {} : { maxResponseBytes: settings.maxResponseBytes }),
    },
    dependencies,
  );
}

/**
 * One entry point for every supported provider:
 *   { type: "groq", apiKey, model, allowedClassifications, ... }              see createGroqProvider
 *   { type: "ollama", baseUrl, model, ... }                                   local development, loopback only
 *   { type: "openai-compatible", id, kind, baseUrl, model, timeoutMs, ... }   any other OpenAI-compatible server,
 *                                                                             under the endpoint policy
 * @param {{ type: "groq" | "ollama" | "openai-compatible" } & Record<string, unknown>} config
 * @param {{ fetch?: typeof fetch, now?: () => number }} [dependencies]
 * @returns {ChatProvider}
 */
export function createProvider(config, dependencies = {}) {
  if (typeof config !== "object" || config === null || !PROVIDER_TYPES.includes(config.type)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, `Provider type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }
  const { type, ...rest } = config;
  if (type === "groq") return createGroqProvider(rest, dependencies);
  if (type === "ollama") {
    const unknown = Object.keys(rest).filter((key) => !OLLAMA_KEYS.has(key));
    if (unknown.length > 0) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Ollama provider configuration has unknown fields", { details: { fields: unknown.slice(0, 5).join(",") } });
    return createOllamaProvider(rest, dependencies);
  }
  return createOpenAICompatibleProvider(rest, dependencies);
}
