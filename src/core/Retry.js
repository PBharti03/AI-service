import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { AiServiceError, createCancelledError } from "../errors/AiServiceError.js";

/**
 * @typedef {(delayMs: number, signal: AbortSignal | undefined) => Promise<void>} Wait
 */

/**
 * Retries are off by default. Queue workers (BullMQ) already retry whole jobs;
 * retrying here as well would multiply load on a busy inference server.
 * When enabled, only errors marked retryable (timeouts, 408/429/5xx,
 * connection failures) are retried; invalid output never is.
 */
export const retryPolicySchema = z.strictObject({
  maxRetries: z.number().int().min(0).max(3).default(0),
  baseDelayMs: z.number().int().min(0).max(30_000).default(500),
  /**
   * Extra attempts when the model's output is invalid (unparseable, off-schema, refused by task
   * validation or rejected by the provider's constrained decoding). Model output varies between
   * attempts, so a second try often succeeds. Off by default.
   */
  invalidOutputRetries: z.number().int().min(0).max(2).default(0),
});

/** Codes of failures caused by the model's output rather than the request. */
export const INVALID_OUTPUT_CODES = new Set(["PROVIDER_OUTPUT_REJECTED", "OUTPUT_PARSE_FAILED", "OUTPUT_SCHEMA_INVALID", "OUTPUT_REJECTED"]);

export async function withRetry(operation, policy, signal, wait = abortableWait) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retriesUsed = attempt - 1;
      const canRetry = error instanceof AiServiceError && error.retryable && retriesUsed < policy.maxRetries;
      if (!canRetry) {
        throw error;
      }
      if (signal?.aborted === true) {
        throw createCancelledError();
      }
      await wait(policy.baseDelayMs * 2 ** retriesUsed, signal);
    }
  }
}

async function abortableWait(delayMs, signal) {
  try {
    await sleep(delayMs, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted === true) {
      throw createCancelledError();
    }
    throw error;
  }
}
