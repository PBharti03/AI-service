import { loopbackHostOf } from "./EndpointPolicy.js";
import { createOpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

/**
 * @typedef {Object} OllamaProviderConfig
 * @property {string} baseUrl - Ollama's OpenAI-compatible endpoint, for example "http://localhost:11434/v1".
 * @property {string} model
 * @property {string} [modelRevision]
 * @property {number} [timeoutMs]
 * @property {string} [id]
 * @property {StructuredOutputMode} [structuredOutput] - Defaults to "json_schema"; confirm support for the installed Ollama version with the integration tests.
 */

export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Local-development preset. It only accepts SYNTHETIC data and only loopback
 * endpoints (localhost, 127.0.0.0/8, ::1); neither can be overridden here. The
 * loopback host is the only entry in its allow-list. A shared CPU or GPU
 * inference server must be configured with createOpenAICompatibleProvider
 * instead, with an administrator allow-list and approved classifications.
 */
export function createOllamaProvider(config, dependencies = {}) {
  const loopbackHost = loopbackHostOf(config.baseUrl);
  return createOpenAICompatibleProvider(
    {
      id: config.id ?? "ollama",
      kind: "SELF_HOSTED",
      baseUrl: config.baseUrl,
      model: config.model,
      ...(config.modelRevision === undefined ? {} : { modelRevision: config.modelRevision }),
      timeoutMs: config.timeoutMs ?? OLLAMA_DEFAULT_TIMEOUT_MS,
      allowedClassifications: ["SYNTHETIC"],
      structuredOutput: config.structuredOutput ?? "json_schema",
      allowInsecurePrivateHttp: false,
      allowedHosts: [loopbackHost],
    },
    dependencies,
  );
}
