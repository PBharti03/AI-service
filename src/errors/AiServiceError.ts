import { ErrorCodes, type ErrorCode } from "./ErrorCodes";

export type ErrorDetailValue = string | number | boolean;
export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export interface AiServiceErrorOptions {
  readonly retryable?: boolean;
  readonly details?: ErrorDetails;
  /** Underlying error. Only its type name and a well-formed error code are kept (see SafeErrorCause). */
  readonly cause?: unknown;
}

/**
 * What remains of an underlying error. Raw errors are never retained because
 * their messages can quote secrets or content: a header error quotes the
 * header value, a JSON SyntaxError quotes the parsed text, and errors thrown
 * by application hooks can contain anything.
 */
export interface SafeErrorCause {
  readonly name: string;
  readonly code?: string;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The only error type the package throws.
 *
 * `message`, `details` and `cause` are built by this package from metadata
 * only (codes, counts, HTTP status, schema-declared paths, error type names),
 * so the error can be logged or inspected without exposing prompts, model
 * output, provider response bodies or credentials. This holds for errors the
 * package creates; an AiServiceError constructed by application code carries
 * whatever that code put in it.
 */
export class AiServiceError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, options: AiServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: toSafeCause(options.cause) });
    this.name = "AiServiceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...options.details });
  }
}

export function createCancelledError(): AiServiceError {
  return new AiServiceError(ErrorCodes.CANCELLED, "The AI request was cancelled");
}

/** Wraps anything that is not already an AiServiceError, keeping only a safe summary of it. */
export function toAiServiceError(error: unknown): AiServiceError {
  if (error instanceof AiServiceError) {
    return error;
  }
  return new AiServiceError(ErrorCodes.INTERNAL_ERROR, "Unexpected error while running the AI task", {
    cause: error,
  });
}

/**
 * Returns a well-formed system error code (for example ECONNREFUSED or
 * UND_ERR_SOCKET) from the error or its direct cause, or undefined.
 */
export function systemErrorCode(error: unknown): string | undefined {
  for (const candidate of [error, causeOf(error)]) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const code = candidate.code;
      if (typeof code === "string" && SAFE_CODE.test(code)) {
        return code;
      }
    }
  }
  return undefined;
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

function toSafeCause(cause: unknown): SafeErrorCause {
  if (cause instanceof AiServiceError) {
    return Object.freeze({ name: cause.name, code: cause.code });
  }
  const name = cause instanceof Error && SAFE_NAME.test(cause.name) ? cause.name : typeof cause;
  const code = systemErrorCode(cause);
  return Object.freeze(code === undefined ? { name } : { name, code });
}
