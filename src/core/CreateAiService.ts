import { z } from "zod";
import { dataClassificationSchema } from "../context/DataClassification";
import { parseTrustedContext, type TrustedContext, type TrustedContextInput } from "../context/TrustedContext";
import { AiServiceError, toAiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import type { ChatProvider, ChatRequest, ProviderInfo } from "../providers/ChatProvider";
import { assertProviderAcceptsClassification, assertTaskAcceptsClassification } from "../security/ClassificationPolicy";
import { composeSystemPrompt, frameUntrustedData } from "../security/PromptFraming";
import { isRegisteredTask, type RegisteredTask } from "../tasks/DefineTask";
import type { TaskRegistry } from "../tasks/TaskRegistry";
import { EMPTY_TOKEN_USAGE, type TaskUsage, type TokenUsage, type UsageRecord } from "../usage/Usage";
import { parseStructuredOutput } from "../validation/StructuredOutput";
import { summarizeZodError } from "../validation/ZodIssues";
import { noopLogger, type AiLogger, type LogMeta } from "./Logger";
import { retryPolicySchema, withRetry, type RetryPolicyInput } from "./Retry";

export interface AiServiceOptions {
  /** Exactly one provider. There is no fallback chain, so no automatic switch to another (paid) provider. */
  readonly provider: ChatProvider;
  readonly registry: TaskRegistry;
  readonly logger?: AiLogger;
  readonly retry?: RetryPolicyInput;
  /** Must be true to use a provider whose kind is PAID. Off by default. */
  readonly allowPaidProvider?: boolean;
  readonly now?: () => number;
  /** Application-wide redaction applied after task minimization, before data reaches the prompt. Receives a frozen context. */
  redact?(data: unknown, context: TrustedContext): unknown;
  /**
   * Called once per task with a metadata-only record, on success and on failure.
   * - Success: if this throws or rejects, the task fails with USAGE_RECORDING_FAILED
   *   and the output is not returned, because metering is mandatory.
   * - Failure: if this throws, the task's own error is still the one thrown; the
   *   metering failure is reported to the logger.
   */
  onUsage?(record: UsageRecord): Promise<void> | void;
}

export interface RunTaskOptions {
  readonly signal?: AbortSignal;
}

export interface TaskResultMeta {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly promptVersion: string;
  readonly providerId: string;
  readonly model: string;
  readonly modelRevision: string | null;
  readonly requestId: string;
}

export interface TaskResult<TOutput> {
  readonly output: TOutput;
  readonly usage: TaskUsage;
  readonly meta: TaskResultMeta;
}

export interface AiService {
  readonly providerInfo: ProviderInfo;
  runTask<TInput extends z.ZodType, TOutput extends z.ZodType>(
    task: RegisteredTask<TInput, TOutput>,
    context: TrustedContextInput,
    input: z.input<TInput>,
    options?: RunTaskOptions,
  ): Promise<TaskResult<z.output<TOutput>>>;
}

const providerInfoSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  kind: z.enum(["SELF_HOSTED", "PAID"]),
  model: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200).nullable(),
  allowedClassifications: z.array(dataClassificationSchema).min(1),
  structuredOutput: z.enum(["json_schema", "json_object", "none"]),
});

interface ExecutionState {
  attempts: number;
  tokens: TokenUsage;
}

export function createAiService(options: AiServiceOptions): AiService {
  // providerInfo is a validated, frozen snapshot taken once. Every policy
  // decision and report uses it, never provider.info, which a custom provider
  // could change later.
  const { provider, providerInfo } = validateProvider(options.provider);
  if (providerInfo.kind === "PAID" && options.allowPaidProvider !== true) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Paid providers require allowPaidProvider: true", {
      details: { providerId: providerInfo.id },
    });
  }
  const retryResult = retryPolicySchema.safeParse(options.retry ?? {});
  if (!retryResult.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Retry policy is invalid", {
      details: summarizeZodError(retryResult.error, retryPolicySchema),
    });
  }
  const retryPolicy = retryResult.data;
  const { registry } = options;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => performance.now());

  /**
   * Logging is best-effort: a logger that throws must not replace the task's
   * result or error. There is nowhere safe left to report the logger's own
   * failure, so it is dropped here deliberately.
   */
  function log(level: keyof AiLogger, message: string, meta: LogMeta): void {
    try {
      logger[level](message, meta);
    } catch {
      // See the function comment: logging failures are intentionally not propagated.
    }
  }

  async function execute<TInput extends z.ZodType, TOutput extends z.ZodType>(
    task: RegisteredTask<TInput, TOutput>,
    context: TrustedContext,
    input: unknown,
    signal: AbortSignal | undefined,
    state: ExecutionState,
  ): Promise<z.output<TOutput>> {
    // Every authorization-related check happens before the provider is called.
    if (!isRegisteredTask(task) || !registry.has(task)) {
      throw new AiServiceError(ErrorCodes.TASK_UNKNOWN, "Task is not registered with this AI service");
    }
    if (!context.permittedTasks.includes(task.id)) {
      throw new AiServiceError(ErrorCodes.TASK_NOT_PERMITTED, "Task is not permitted for this request", {
        details: { taskId: task.id },
      });
    }
    assertTaskAcceptsClassification(task.id, task.maxClassification, context.dataClassification);
    assertProviderAcceptsClassification(providerInfo, context.dataClassification);

    const parsedInput = task.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Task input is invalid", {
        details: summarizeZodError(parsedInput.error, task.inputSchema),
      });
    }
    const minimized: unknown = task.minimize ? task.minimize(parsedInput.data) : parsedInput.data;
    const promptData: unknown = options.redact ? options.redact(minimized, context) : minimized;

    const request: ChatRequest = {
      messages: [
        { role: "system", content: composeSystemPrompt(task.instructions, task.outputJsonSchema) },
        { role: "user", content: frameUntrustedData(task.dataLabel, promptData) },
      ],
      generation: task.generation,
      jsonSchema: { name: task.id.replace(/[^A-Za-z0-9_-]/g, "_"), schema: task.outputJsonSchema },
    };

    const result = await withRetry(
      (attempt) => {
        state.attempts = attempt;
        return provider.complete(request, signal === undefined ? {} : { signal });
      },
      retryPolicy,
      signal,
    );
    state.tokens = result.usage;

    const output = parseStructuredOutput(result.content, task.outputSchema, result.finishReason);
    const verdict = task.postValidate ? task.postValidate(output, parsedInput.data) : { ok: true as const };
    if (!verdict.ok) {
      throw new AiServiceError(ErrorCodes.OUTPUT_REJECTED, "Model output was rejected by task validation", {
        details: { taskId: task.id, reason: verdict.reason.slice(0, 100) },
      });
    }
    return output;
  }

  async function runTask<TInput extends z.ZodType, TOutput extends z.ZodType>(
    task: RegisteredTask<TInput, TOutput>,
    contextInput: TrustedContextInput,
    input: z.input<TInput>,
    runOptions: RunTaskOptions = {},
  ): Promise<TaskResult<z.output<TOutput>>> {
    const started = now();
    const state: ExecutionState = { attempts: 0, tokens: EMPTY_TOKEN_USAGE };
    let context: TrustedContext | undefined;
    let output: z.output<TOutput>;

    try {
      context = parseTrustedContext(contextInput);
      output = await execute(task, context, input, runOptions.signal, state);
    } catch (error) {
      const failure = toAiServiceError(error);
      const usage = toTaskUsage(state, now() - started);
      const meta = logMeta(task, context, usage);
      log("warn", "AI task failed", { ...meta, errorCode: failure.code, retryable: failure.retryable });
      if (context !== undefined && isRegisteredTask(task)) {
        await recordFailureUsage(buildUsageRecord(task, context, "FAILURE", failure, usage), meta);
      }
      throw failure;
    }

    const usage = toTaskUsage(state, now() - started);
    const record = buildUsageRecord(task, context, "SUCCESS", null, usage);
    if (options.onUsage) {
      try {
        await options.onUsage(record);
      } catch (error) {
        log("error", "AI usage recording failed", { ...logMeta(task, context, usage), errorCode: ErrorCodes.USAGE_RECORDING_FAILED });
        throw new AiServiceError(ErrorCodes.USAGE_RECORDING_FAILED, "Usage could not be recorded", { cause: error });
      }
    }
    log("info", "AI task completed", logMeta(task, context, usage));

    return {
      output,
      usage,
      meta: {
        taskId: task.id,
        taskVersion: task.version,
        promptVersion: task.promptVersion,
        providerId: providerInfo.id,
        model: providerInfo.model,
        modelRevision: providerInfo.modelRevision,
        requestId: context.requestId,
      },
    };
  }

  async function recordFailureUsage(record: UsageRecord, meta: LogMeta): Promise<void> {
    if (!options.onUsage) {
      return;
    }
    try {
      await options.onUsage(record);
    } catch {
      // The task's own error is what the caller must see; the metering
      // failure is reported through the logger instead of replacing it.
      log("error", "AI usage recording failed", { ...meta, errorCode: ErrorCodes.USAGE_RECORDING_FAILED });
    }
  }

  function buildUsageRecord(
    task: RegisteredTask<z.ZodType, z.ZodType>,
    context: TrustedContext,
    outcome: UsageRecord["outcome"],
    failure: AiServiceError | null,
    usage: TaskUsage,
  ): UsageRecord {
    return {
      applicationId: context.applicationId,
      tenantId: context.tenantId,
      actorType: context.actor.type,
      userId: context.actor.userId,
      requestId: context.requestId,
      taskId: task.id,
      taskVersion: task.version,
      promptVersion: task.promptVersion,
      providerId: providerInfo.id,
      model: providerInfo.model,
      outcome,
      errorCode: failure?.code ?? null,
      usage,
    };
  }

  function logMeta(task: unknown, context: TrustedContext | undefined, usage: TaskUsage): LogMeta {
    const taskMeta = isRegisteredTask(task)
      ? { taskId: task.id, taskVersion: task.version, promptVersion: task.promptVersion }
      : { taskId: "unregistered" };
    return {
      ...taskMeta,
      applicationId: context?.applicationId,
      tenantId: context?.tenantId,
      requestId: context?.requestId,
      providerId: providerInfo.id,
      model: providerInfo.model,
      attempts: usage.attempts,
      latencyMs: Math.round(usage.latencyMs),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    };
  }

  return Object.freeze({ providerInfo, runTask });
}

function toTaskUsage(state: ExecutionState, elapsedMs: number): TaskUsage {
  return { ...state.tokens, latencyMs: Math.max(0, elapsedMs), attempts: state.attempts };
}

/**
 * Checks the provider contract and takes a frozen copy of its info. Zod
 * returns new objects and arrays, so later changes to the provider's own info
 * (or to an array it shares with application config) cannot affect the copy.
 */
function validateProvider(candidate: unknown): { provider: ChatProvider; providerInfo: ProviderInfo } {
  const provider = candidate as Partial<ChatProvider> | null | undefined;
  const info = providerInfoSchema.safeParse(provider?.info);
  if (typeof provider?.complete !== "function" || typeof provider.healthCheck !== "function" || !info.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Provider does not implement the ChatProvider contract");
  }
  const providerInfo: ProviderInfo = Object.freeze({
    ...info.data,
    allowedClassifications: Object.freeze([...info.data.allowedClassifications]),
  });
  return { provider: provider as ChatProvider, providerInfo };
}
