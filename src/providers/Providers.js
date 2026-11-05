import { z } from "zod";
import { dataClassificationSchema } from "../core/Context.js";
import { AiServiceError, createCancelledError, ErrorCodes, summarizeZodError, systemErrorCode } from "../core/Errors.js";

// Types only: the contract every model backend implements (documented for editors via JSDoc).

/**
 * @typedef {"SELF_HOSTED" | "PAID"} ProviderKind
 */

/**
 * How the provider is asked to constrain output. Support differs between servers and versions (vLLM and others), so this is a per-deployment setting confirmed by integration tests, never assumed. Output is always validated with Zod afterwards regardless of the mode.
 * @typedef {"json_schema" | "json_object" | "none"} StructuredOutputMode
 */

/**
 * @typedef {Object} ProviderInfo
 * @property {string} id
 * @property {ProviderKind} kind
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

/**
 * @typedef {Object} EndpointPolicyOptions
 * @property {ProviderKind} providerKind
 * @property {boolean} allowInsecurePrivateHttp - Permit plain HTTP to allow-listed private IPs and single-label hosts (for example "vllm" on a Docker network).
 * @property {readonly string[]} allowedHosts - Administrator-approved hosts for SELF_HOSTED providers. Every self-hosted host must be listed. Ignored for PAID.
 */

/** The only external (PAID) endpoints the package will call: HTTPS on the default port, exact hostname. */
export const APPROVED_PAID_HOSTS = Object.freeze(["api.groq.com"]);

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Validates a provider base URL before any request is made.
 *
 * - PAID providers: HTTPS, default port, and a hostname in APPROVED_PAID_HOSTS.
 * - SELF_HOSTED providers: the host must be in the administrator allow-list.
 *   Nothing is trusted implicitly, including single-label names and private
 *   IPs. Plain HTTP is only allowed to allow-listed loopback hosts, or to
 *   allow-listed private / single-label hosts when allowInsecurePrivateHttp
 *   is set; never to public hosts. Approved PAID hosts cannot be configured as
 *   SELF_HOSTED, so the paid-provider opt-in cannot be bypassed.
 * - Always refused: link-local (cloud metadata), unspecified, multicast and
 *   IPv4-mapped IPv6 addresses; credentials, queries and fragments in the URL.
 *
 * DNS is not resolved. Node's built-in fetch does not expose a supported way
 * to check the address it actually connects to, so a resolved-address check
 * here could not be guaranteed to match the connection (DNS rebinding). The
 * allow-list is the control: administrators must only list names whose DNS
 * they control.
 */
export function resolveProviderBaseUrl(baseUrl, options) {
  const url = parseBaseUrl(baseUrl);
  const host = hostOf(url);
  const hostClass = classifyHost(host);

  if (hostClass === "forbidden") {
    throw configError("Provider host is not permitted", "forbidden_address");
  }

  if (options.providerKind === "PAID") {
    if (url.protocol !== "https:" || url.port !== "" || !APPROVED_PAID_HOSTS.includes(host)) {
      throw configError("Paid providers require HTTPS to an approved hostname", "paid_endpoint_not_allowed");
    }
    return withTrailingSlash(url);
  }

  if (APPROVED_PAID_HOSTS.includes(host)) {
    throw configError("Hosted provider endpoints must be configured as PAID providers", "paid_host_requires_paid_kind");
  }
  const allowedHosts = options.allowedHosts.map(normalizeAllowedHost);
  if (!allowedHosts.includes(host)) {
    throw configError("Self-hosted provider host is not in the administrator allow-list", "host_not_allowlisted");
  }

  if (url.protocol === "http:") {
    const privateNetwork = hostClass === "private" || hostClass === "internal-name";
    if (hostClass !== "loopback" && !(privateNetwork && options.allowInsecurePrivateHttp)) {
      throw configError(
        "Plain HTTP is only allowed for loopback, or private hosts when allowInsecurePrivateHttp is set",
        "insecure_http",
      );
    }
  }

  return withTrailingSlash(url);
}

/**
 * Normalises an allow-list entry the same way URLs are normalised, so
 * "LOCALHOST", "127.1" and "::1" compare correctly. Entries must be a bare
 * hostname or IP address (no scheme, port or path).
 */
export function normalizeAllowedHost(entry) {
  const bracketed = entry.includes(":") ? `[${entry.replace(/^\[|\]$/g, "")}]` : entry;
  let url;
  try {
    url = new URL(`http://${bracketed}/`);
  } catch {
    throw configError("Allow-listed host is invalid", "invalid_allowed_host");
  }
  if (url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw configError("Allow-listed host must be a bare hostname or IP address", "invalid_allowed_host");
  }
  const host = hostOf(url);
  if (classifyHost(host) === "forbidden") {
    throw configError("Allow-listed host is not permitted", "forbidden_address");
  }
  return host;
}

/** Returns the base URL's host if it is loopback; otherwise throws CONFIG_INVALID. */
export function loopbackHostOf(baseUrl) {
  const host = hostOf(parseBaseUrl(baseUrl));
  if (classifyHost(host) !== "loopback") {
    throw configError("This provider preset only allows loopback endpoints", "loopback_required");
  }
  return host;
}

function parseBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw configError("Provider baseUrl is not a valid URL", "invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configError("Provider baseUrl must use http or https", "unsupported_protocol");
  }
  if (url.username !== "" || url.password !== "") {
    throw configError("Provider baseUrl must not contain credentials", "credentials_in_url");
  }
  if (url.search !== "" || url.hash !== "") {
    throw configError("Provider baseUrl must not contain a query or fragment", "query_or_fragment");
  }
  return url;
}

function hostOf(url) {
  return url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function classifyHost(host) {
  if (host === "localhost") {
    return "loopback";
  }
  if (IPV4_PATTERN.test(host)) {
    return classifyIPv4(host);
  }
  if (host.includes(":")) {
    return classifyIPv6(host);
  }
  if (host.length > 253 || !HOSTNAME_PATTERN.test(host)) {
    return "forbidden";
  }
  return host.includes(".") ? "public" : "internal-name";
}

function classifyIPv4(host) {
  const octets = host.split(".").map(Number);
  const [a = -1, b = -1] = octets;
  if (octets.some((octet) => octet > 255)) {
    return "forbidden";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 0 || a >= 224 || (a === 169 && b === 254)) {
    return "forbidden";
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  return "public";
}

function classifyIPv6(host) {
  if (host === "::1") {
    return "loopback";
  }
  if (host === "::" || host.startsWith("::ffff:")) {
    return "forbidden";
  }
  const firstHextet = Number.parseInt(host.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstHextet)) {
    return "forbidden";
  }
  if ((firstHextet & 0xffc0) === 0xfe80 || (firstHextet & 0xff00) === 0xff00) {
    return "forbidden";
  }
  if ((firstHextet & 0xfe00) === 0xfc00) {
    return "private";
  }
  return "public";
}

function withTrailingSlash(url) {
  const normalized = new URL(url.href);
  if (!normalized.pathname.endsWith("/")) {
    normalized.pathname = `${normalized.pathname}/`;
  }
  return normalized;
}

function configError(message, reason) {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, message, { details: { reason } });
}

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
 * (`POST {baseUrl}chat/completions`, `GET {baseUrl}models`), such as vLLM.
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
/** Groq model used when an application names none; the package's tasks are tuned for it. */
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
export const PROVIDER_TYPES = Object.freeze(["groq", "openai-compatible"]);

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
  model: z.string().min(1).max(200).default(GROQ_DEFAULT_MODEL),
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
 * @param {{ apiKey: string, model?: string, allowedClassifications: DataClassification[], id?: string, modelRevision?: string, timeoutMs?: number, structuredOutput?: StructuredOutputMode, maxRequestBytes?: number, maxResponseBytes?: number }} config
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
 *   { type: "groq", apiKey, model?, allowedClassifications, ... }             see createGroqProvider (model defaults to GROQ_DEFAULT_MODEL)
 *   { type: "openai-compatible", id, kind, baseUrl, model, timeoutMs, ... }   any other OpenAI-compatible server,
 *                                                                             under the endpoint policy
 * @param {{ type: "groq" | "openai-compatible" } & Record<string, unknown>} config
 * @param {{ fetch?: typeof fetch, now?: () => number }} [dependencies]
 * @returns {ChatProvider}
 */
export function createProvider(config, dependencies = {}) {
  if (typeof config !== "object" || config === null || !PROVIDER_TYPES.includes(config.type)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, `Provider type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }
  const { type, ...rest } = config;
  if (type === "groq") return createGroqProvider(rest, dependencies);
  return createOpenAICompatibleProvider(rest, dependencies);
}
