import type { ChatProvider, StructuredOutputMode } from "./ChatProvider";
import { loopbackHostOf } from "./EndpointPolicy";
import { createOpenAICompatibleProvider, type ProviderDependencies } from "./OpenAICompatibleProvider";

export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;

export interface OllamaProviderConfig {
  /** Ollama's OpenAI-compatible endpoint, for example "http://localhost:11434/v1". */
  readonly baseUrl: string;
  readonly model: string;
  readonly modelRevision?: string;
  readonly timeoutMs?: number;
  readonly id?: string;
  /** Defaults to "json_schema"; confirm support for the installed Ollama version with the integration tests. */
  readonly structuredOutput?: StructuredOutputMode;
}

/**
 * Local-development preset. It only accepts SYNTHETIC data and only loopback
 * endpoints (localhost, 127.0.0.0/8, ::1); neither can be overridden here. The
 * loopback host is the only entry in its allow-list. A shared CPU or GPU
 * inference server must be configured with createOpenAICompatibleProvider
 * instead, with an administrator allow-list and approved classifications.
 */
export function createOllamaProvider(
  config: OllamaProviderConfig,
  dependencies: ProviderDependencies = {},
): ChatProvider {
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
