import { z } from "zod";
import { dataClassificationSchema } from "../context/DataClassification.js";
import { AiServiceError, createCancelledError, systemErrorCode } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { resolveProviderBaseUrl } from "./EndpointPolicy.js";

/**
 * @typedef {Object} ProviderDependencies
 * @property {typeof globalThis.fetch} [fetch] - Injected for tests. Defaults to the global fetch, resolved at call time.
 * @property {() => number} [now]
 */

export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Network failures worth retrying: the server was briefly unreachable or the
 * connection dropped. Everything else (redirects, invalid headers or URLs,
 * TLS and DNS-not-found errors, unknown failures) is deterministic and is
 * reported as non-retryable.
 */
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
  kind: z.enum(["SELF_HOSTED", "PAID"]),
  baseUrl: z.string().min(1).max(2048),
  model: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200).optional(),
  // Visible ASCII only, so the key is a valid header value and can never
  // surface in a header-validation error.
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  timeoutMs: z.number().int().min(100).max(600_000),
  allowedClassifications: z.array(dataClassificationSchema).min(1),
  structuredOutput: z.enum(["json_schema", "json_object", "none"]),
  allowInsecurePrivateHttp: z.boolean().default(false),
  allowedHosts: z.array(z.string().min(1).max(253)).max(20).default([]),
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
 * Adapter for servers exposing the OpenAI Chat Completions API
 * (`POST {baseUrl}chat/completions`, `GET {baseUrl}models`), such as vLLM and
 * Ollama's `/v1` endpoint.
 *
 * The API key, if any, is held only in this closure: it is not a property of
 * the returned object, so serializing or logging the provider cannot leak it.
 */
export function createOpenAICompatibleProvider(config, dependencies = {}) {
  const parsed = providerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Provider configuration is invalid", {
      details: summarizeZodError(parsed.error, providerConfigSchema),
    });
  }
  const settings = parsed.data;
  const baseUrl = resolveProviderBaseUrl(settings.baseUrl, {
    providerKind: settings.kind,
    allowInsecurePrivateHttp: settings.allowInsecurePrivateHttp,
    allowedHosts: settings.allowedHosts,
  });
  const completionsUrl = new URL("chat/completions", baseUrl);
  const modelsUrl = new URL("models", baseUrl);
  const now = dependencies.now ?? (() => performance.now());

  const info = Object.freeze({
    id: settings.id,
    kind: settings.kind,
    model: settings.model,
    modelRevision: settings.modelRevision ?? null,
    allowedClassifications: Object.freeze([...settings.allowedClassifications]),
    structuredOutput: settings.structuredOutput,
  });

  function buildHeaders() {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(settings.apiKey === undefined ? {} : { authorization: `Bearer ${settings.apiKey}` }),
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

    const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
    const signal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, callerSignal]);
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
        await discardBody(response);
        throw httpError(response.status);
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
      if (isAborted(callerSignal)) {
        throw createCancelledError();
      }
      if (isAborted(timeoutSignal)) {
        throw new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "Provider request timed out", {
          retryable: true,
          details: { timeoutMs: settings.timeoutMs },
        });
      }
      throw networkError(error);
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

/**
 * Signals abort asynchronously, so this is read through a function call:
 * TypeScript would otherwise keep a narrowing from an earlier check.
 */
function isAborted(signal) {
  return signal?.aborted === true;
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

/**
 * Classifies a fetch failure that was not a timeout or cancellation. Only a
 * type name and system error code are kept; the raw error is dropped because
 * its message can quote header values (including the API key) or URLs.
 */
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

function httpError(status) {
  const retryable = status === 408 || status === 429 || status >= 500;
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

function mapFinishReason(value) {
  if (value === "stop") {
    return "stop";
  }
  if (value === "length") {
    return "length";
  }
  return "other";
}

function mapUsage(usage) {
  const promptTokens = usage?.prompt_tokens ?? null;
  const completionTokens = usage?.completion_tokens ?? null;
  const reportedTotal = usage?.total_tokens ?? null;
  const derivedTotal = promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
  return { promptTokens, completionTokens, totalTokens: reportedTotal ?? derivedTotal };
}
