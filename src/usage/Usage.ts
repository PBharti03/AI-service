import type { ErrorCode } from "../errors/ErrorCodes";

/** Token counts as reported by the provider; null when it did not report them. */
export interface TokenUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface TaskUsage extends TokenUsage {
  readonly latencyMs: number;
  /** Provider calls made, including retries. 0 when the task failed before calling the provider. */
  readonly attempts: number;
}

/** Metadata-only record for metering and quotas. Contains no prompt or output content. */
export interface UsageRecord {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorType: "USER" | "SYSTEM";
  readonly userId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly promptVersion: string;
  readonly providerId: string;
  readonly model: string;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly errorCode: ErrorCode | null;
  readonly usage: TaskUsage;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = Object.freeze({
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
});
