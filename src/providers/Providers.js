import { z } from "zod";
import { dataClassificationSchema } from "../core/Context.js";
import { AiServiceError, createCancelledError, ErrorCodes, summarizeZodError, systemErrorCode } from "../core/Errors.js";
import { createDeadline } from "../core/Deadline.js";
import { APPROVED_PROVIDER_HOSTS, DEFAULT_MAX_REQUEST_BYTES, DEFAULT_MAX_RESPONSE_BYTES } from "../constants/ProviderConstants.js";

// Types only: the contract every model backend implements (documented for editors via JSDoc).

/**
 * How the provider is asked to constrain output. Support differs between servers and versions (vLLM and others), so this is a per-deployment setting confirmed by integration tests, never assumed. Output is always validated with Zod afterwards regardless of the mode.
 * @typedef {"json_schema" | "json_object" | "none"} StructuredOutputMode
 */

/**
 * @typedef {Object} ProviderInfo
 * @property {string} id
 * @property {string} model
 * @property {string | null} modelRevision
 * @property {readonly DataClassification[]} allowedClassifications
 * @property {StructuredOutputMode} structuredOutput
 */

/**
 * Only system and user roles exist: there is no tool or function-call role.
 * @typedef {Object} ChatMessage
 * @property {"system" | "user"} role
 * @property {string} content
 */

/**
 * @typedef {Object} GenerationSettings
 * @property {number} temperature
 * @property {number} maxTokens
 * @property {number} [topP]
 * @property {number} [seed]
 */

/**
 * @typedef {Object} JsonSchemaFormat
 * @property {string} name
 * @property {object} schema
 */

/**
 * Deliberately has no `tools` field: the model cannot be offered tools.
 * @typedef {Object} ChatRequest
 * @property {readonly ChatMessage[]} messages
 * @property {GenerationSettings} generation
 * @property {JsonSchemaFormat} [jsonSchema]
 */

/**
 * @typedef {"stop" | "length" | "other"} FinishReason
 */

/**
 * @typedef {Object} ChatResult
 * @property {string} content
 * @property {FinishReason} finishReason
 * @property {TokenUsage} usage
 * @property {string} model
 * @property {number} latencyMs
 */

/**
 * @typedef {Object} CallOptions
 * @property {AbortSignal} [signal]
 */

/**
 * Contract every model backend implements. Implementations must throw AiServiceError only, and must never put prompt text, model output or raw response bodies into errors.
 * @typedef {Object} ChatProvider
 * @property {ProviderInfo} info
 * @property {(request: ChatRequest, options?: CallOptions) => Promise<ChatResult>} complete
 * @property {(options?: CallOptions) => Promise<void>} healthCheck
 */

export {};

/** The provider base URL: HTTPS on the default port to an approved host, without credentials or a query. */
function providerBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw configError("Provider baseUrl is not a valid URL", "invalid_url");
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw configError("Provider baseUrl must be plain HTTPS", "insecure_url");
  }
  if (!APPROVED_PROVIDER_HOSTS.includes(url.hostname.toLowerCase())) throw configError("Provider host is not approved", "host_not_approved");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function configError(message, reason) {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, message, { details: { reason } });
}

/**
 * @typedef {Object} ProviderDependencies
 * @property {typeof globalThis.fetch} [fetch] - Injected for tests. Defaults to the global fetch, resolved at call time.
 * @property {() => number} [now]
 */

/** Network failures worth retrying: the server was briefly unreachable or the connection dropped. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const providerConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  baseUrl: z.string().min(1).max(2048),
  model: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200).optional(),
  // Visible ASCII only, so the key is a valid header value and can never
  // surface in a header-validation error.
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  timeoutMs: z.number().int().min(100).max(600_000),
  allowedClassifications: z.array(dataClassificationSchema).min(1),
  structuredOutput: z.enum(["json_schema", "json_object", "none"]),
  maxRequestBytes: z.number().int().min(1024).max(5_000_000).default(DEFAULT_MAX_REQUEST_BYTES),
  maxResponseBytes: z.number().int().min(1024).max(10_000_000).default(DEFAULT_MAX_RESPONSE_BYTES),
});

const completionResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/**
 * The provider client for any OpenAI-compatible Chat Completions API (`POST {baseUrl}chat/completions`, `GET
 * {baseUrl}models`), configured by AI_PROVIDER_CONFIG.
 * @param {{ id: string, baseUrl: string, model: string, apiKey: string, timeoutMs: number, structuredOutput: StructuredOutputMode, allowedClassifications: DataClassification[], modelRevision?: string, maxRequestBytes?: number, maxResponseBytes?: number }} config
 * @param {{ fetch?: typeof fetch, now?: () => number }} [dependencies]
 * @returns {ChatProvider}
 */
export function createProvider(config, dependencies = {}) {
  const parsed = providerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Provider configuration is invalid", {
      details: summarizeZodError(parsed.error, providerConfigSchema),
    });
  }
  const settings = parsed.data;
  const baseUrl = providerBaseUrl(settings.baseUrl);
  const completionsUrl = new URL("chat/completions", baseUrl);
  const modelsUrl = new URL("models", baseUrl);
  const now = dependencies.now ?? (() => performance.now());

  const info = Object.freeze({
    id: settings.id,
    model: settings.model,
    modelRevision: settings.modelRevision ?? null,
    allowedClassifications: Object.freeze([...settings.allowedClassifications]),
    structuredOutput: settings.structuredOutput,
  });

  function buildHeaders() {
    return {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    };
  }

  async function requestJson(url, body, callerSignal) {
    if (body !== undefined && Buffer.byteLength(body, "utf8") > settings.maxRequestBytes) {
      throw new AiServiceError(ErrorCodes.REQUEST_TOO_LARGE, "Provider request exceeds the configured size limit", {
        details: { limitBytes: settings.maxRequestBytes },
      });
    }
    if (callerSignal?.aborted === true) {
      throw createCancelledError();
    }

    const deadline = createDeadline(settings.timeoutMs, callerSignal);
    const { signal } = deadline;
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;

    try {
      const response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: buildHeaders(),
        ...(body === undefined ? {} : { body }),
        signal,
        // Redirects are refused: following one could send the request,
        // including any Authorization header, to a host the policy never checked.
        redirect: "error",
      });

      if (!response.ok) {
        // A 400 may be the server refusing the model's own output under constrained decoding
        // (for example Groq's json_validate_failed): read only its error code, from a bounded body.
        const rejectedOutput = response.status === 400 && (await structuredOutputRejected(response));
        if (!rejectedOutput) await discardBody(response);
        if (rejectedOutput) {
          throw new AiServiceError(ErrorCodes.PROVIDER_OUTPUT_REJECTED, "The provider rejected the model output as invalid structured output", {
            details: { status: 400, reason: "structured_output_rejected" },
          });
        }
        throw httpError(response.status, response.headers);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        await discardBody(response);
        throw invalidResponse("content_type");
      }

      const text = await readLimitedText(response, settings.maxResponseBytes);
      try {
        return JSON.parse(text);
      } catch {
        throw invalidResponse("not_json");
      }
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw error;
      }
      if (callerSignal?.aborted === true) {
        throw createCancelledError();
      }
      if (deadline.expired()) {
        throw new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "Provider request timed out", {
          retryable: true,
          details: { timeoutMs: settings.timeoutMs },
        });
      }
      throw networkError(error);
    } finally {
      deadline.dispose();
    }
  }

  async function complete(request, options = {}) {
    const body = {
      model: settings.model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: request.generation.temperature,
      max_tokens: request.generation.maxTokens,
      stream: false,
      ...(request.generation.topP === undefined ? {} : { top_p: request.generation.topP }),
      ...(request.generation.seed === undefined ? {} : { seed: request.generation.seed }),
    };
    if (request.jsonSchema !== undefined) {
      if (settings.structuredOutput === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
        };
      } else if (settings.structuredOutput === "json_object") {
        body.response_format = { type: "json_object" };
      }
    }

    const started = now();
    const raw = await requestJson(completionsUrl, JSON.stringify(body), options.signal);
    const parsed = completionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidResponse("shape");
    }
    const choice = parsed.data.choices[0];
    if (choice === undefined) {
      throw invalidResponse("shape");
    }
    if (choice.message.tool_calls != null && choice.message.tool_calls.length > 0) {
      throw invalidResponse("tool_calls");
    }
    if (typeof choice.message.content !== "string") {
      throw invalidResponse("missing_content");
    }
    if (parsed.data.model !== undefined && parsed.data.model !== settings.model) {
      throw invalidResponse("model_mismatch");
    }

    return {
      content: choice.message.content,
      finishReason: mapFinishReason(choice.finish_reason),
      usage: mapUsage(parsed.data.usage),
      model: settings.model,
      latencyMs: Math.max(0, now() - started),
    };
  }

  async function healthCheck(options = {}) {
    const raw = await requestJson(modelsUrl, undefined, options.signal);
    const parsed = modelListSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidResponse("shape");
    }
    if (!parsed.data.data.some((entry) => entry.id === settings.model)) {
      throw new AiServiceError(ErrorCodes.PROVIDER_UNAVAILABLE, "Configured model is not served by the provider", {
        details: { reason: "model_not_served" },
      });
    }
  }

  return Object.freeze({ info, complete, healthCheck });
}

async function readLimitedText(response, limitBytes) {
  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    await discardBody(response);
    throw responseTooLarge(limitBytes);
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      // The stream is typed `any` by the platform types; check each chunk instead of trusting it.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) {
        throw invalidResponse("body_chunk");
      }
      received += value.byteLength;
      if (received > limitBytes) {
        throw responseTooLarge(limitBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Any failure while streaming abandons the body: release the connection.
    await cancelReader(reader);
    throw error;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw invalidResponse("invalid_utf8");
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body is never read; failing to release it does not change the
    // error already being reported to the caller.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // An already-errored stream rejects cancel(); the error being reported
    // to the caller is the one that matters.
  }
}

/** Classifies a fetch failure that was not a timeout or cancellation. */
function networkError(error) {
  if (isRedirectRejection(error)) {
    return new AiServiceError(ErrorCodes.PROVIDER_HTTP_ERROR, "Provider attempted a redirect, which is not allowed", {
      details: { reason: "redirect" },
    });
  }
  const code = systemErrorCode(error);
  const transient = code !== undefined && TRANSIENT_NETWORK_CODES.has(code);
  return new AiServiceError(ErrorCodes.PROVIDER_UNAVAILABLE, "Provider request failed", {
    retryable: transient,
    details: { reason: code ?? "request_failed" },
    cause: error,
  });
}

/** Node's fetch rejects with TypeError("fetch failed", { cause: Error("unexpected redirect") }) under redirect: "error". */
function isRedirectRejection(error) {
  return error instanceof Error && error.cause instanceof Error && error.cause.message === "unexpected redirect";
}

/** Longest wait a provider's Retry-After may ask for (seconds); larger values are capped. */
const MAX_RETRY_AFTER_SECONDS = 300;

/** Error codes by which OpenAI-compatible servers report model output that failed their JSON schema. */
const OUTPUT_REJECTION_CODES = new Set(["json_validate_failed", "invalid_json_output"]);

async function structuredOutputRejected(response) {
  try {
    const body = JSON.parse(await readLimitedText(response, 64 * 1024));
    return typeof body?.error?.code === "string" && OUTPUT_REJECTION_CODES.has(body.error.code);
  } catch {
    return false;
  }
}

function httpError(status, headers) {
  if (status === 429) {
    // Rate limited: its own code, with the provider's Retry-After (seconds, bounded) when it sends one.
    const raw = headers?.get?.("retry-after");
    const header = typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
    const retryAfterSeconds = Number.isFinite(header) ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(header)) : undefined;
    return new AiServiceError(ErrorCodes.PROVIDER_RATE_LIMITED, "Provider rate limit reached (HTTP 429)", {
      retryable: true,
      details: { status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    });
  }
  const retryable = status === 408 || status >= 500;
  const code = status === 503 ? ErrorCodes.PROVIDER_UNAVAILABLE : ErrorCodes.PROVIDER_HTTP_ERROR;
  return new AiServiceError(code, `Provider responded with HTTP ${String(status)}`, {
    retryable,
    details: { status },
  });
}

function invalidResponse(reason) {
  return new AiServiceError(ErrorCodes.PROVIDER_RESPONSE_INVALID, "Provider response is invalid", {
    details: { reason },
  });
}

function responseTooLarge(limitBytes) {
  return new AiServiceError(ErrorCodes.PROVIDER_RESPONSE_INVALID, "Provider response exceeds the configured size limit", {
    details: { reason: "too_large", limitBytes },
  });
}

const mapFinishReason = (value) => (value === "stop" || value === "length" ? value : "other");

function mapUsage(usage) {
  const promptTokens = usage?.prompt_tokens ?? null;
  const completionTokens = usage?.completion_tokens ?? null;
  const reportedTotal = usage?.total_tokens ?? null;
  const derivedTotal = promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
  return { promptTokens, completionTokens, totalTokens: reportedTotal ?? derivedTotal };
}
