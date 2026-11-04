// Types only: the contract every model backend implements (documented for editors via JSDoc).

/**
 * @typedef {"SELF_HOSTED" | "PAID"} ProviderKind
 */

/**
 * How the provider is asked to constrain output. Support differs between servers and versions (Ollama, vLLM, others), so this is a per-deployment setting confirmed by integration tests, never assumed. Output is always validated with Zod afterwards regardless of the mode.
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
