import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { AiServiceError, createCancelledError } from "../errors/AiServiceError";

/**
 * Retries are off by default. Queue workers (BullMQ) already retry whole jobs;
 * retrying here as well would multiply load on a busy inference server.
 * When enabled, only errors marked retryable (timeouts, 408/429/5xx,
 * connection failures) are retried; invalid output never is.
 */
export const retryPolicySchema = z.strictObject({
  maxRetries: z.number().int().min(0).max(3).default(0),
  baseDelayMs: z.number().int().min(0).max(30_000).default(500),
});

export type RetryPolicy = z.output<typeof retryPolicySchema>;
export type RetryPolicyInput = z.input<typeof retryPolicySchema>;

export type Wait = (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  wait: Wait = abortableWait,
): Promise<T> {
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

async function abortableWait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(delayMs, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted === true) {
      throw createCancelledError();
    }
    throw error;
  }
}
