import type { DataClassification } from "../context/DataClassification";
import type { TokenUsage } from "../usage/Usage";

export type ProviderKind = "SELF_HOSTED" | "PAID";

/**
 * How the provider is asked to constrain output. Support differs between
 * servers and versions (Ollama, vLLM, others), so this is a per-deployment
 * setting confirmed by integration tests, never assumed. Output is always
 * validated with Zod afterwards regardless of the mode.
 */
export type StructuredOutputMode = "json_schema" | "json_object" | "none";

export interface ProviderInfo {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly modelRevision: string | null;
  readonly allowedClassifications: readonly DataClassification[];
  readonly structuredOutput: StructuredOutputMode;
}

/** Only system and user roles exist: there is no tool or function-call role. */
export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface GenerationSettings {
  readonly temperature: number;
  readonly maxTokens: number;
  readonly topP?: number;
  readonly seed?: number;
}

export interface JsonSchemaFormat {
  readonly name: string;
  readonly schema: object;
}

/** Deliberately has no `tools` field: the model cannot be offered tools. */
export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly generation: GenerationSettings;
  readonly jsonSchema?: JsonSchemaFormat;
}

export type FinishReason = "stop" | "length" | "other";

export interface ChatResult {
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly latencyMs: number;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Contract every model backend implements. Implementations must throw
 * AiServiceError only, and must never put prompt text, model output or raw
 * response bodies into errors.
 */
export interface ChatProvider {
  readonly info: ProviderInfo;
  complete(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  healthCheck(options?: CallOptions): Promise<void>;
}
