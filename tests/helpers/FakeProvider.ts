import {
  AiServiceError,
  ErrorCodes,
  type CallOptions,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type FinishReason,
  type ProviderInfo,
  type TokenUsage,
} from "../../src";

export type FakeStep =
  | { readonly kind: "reply"; readonly content: string; readonly finishReason?: FinishReason; readonly usage?: TokenUsage }
  | { readonly kind: "fail"; readonly error: Error }
  | { readonly kind: "hang" };

const DEFAULT_USAGE: TokenUsage = { promptTokens: 40, completionTokens: 12, totalTokens: 52 };

/** Scripted provider: each call consumes the next step. Records every request it receives. */
export class FakeProvider implements ChatProvider {
  readonly info: ProviderInfo;
  readonly requests: ChatRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[], info: Partial<ProviderInfo> = {}) {
    this.steps = [...steps];
    this.info = {
      id: "fake",
      kind: "SELF_HOSTED",
      model: "fake-model",
      modelRevision: null,
      allowedClassifications: ["SYNTHETIC", "INTERNAL", "CONFIDENTIAL"],
      structuredOutput: "json_schema",
      ...info,
    };
  }

  complete(request: ChatRequest, options: CallOptions = {}): Promise<ChatResult> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error("FakeProvider has no scripted step left"));
    }
    switch (step.kind) {
      case "reply":
        return Promise.resolve({
          content: step.content,
          finishReason: step.finishReason ?? "stop",
          usage: step.usage ?? DEFAULT_USAGE,
          model: this.info.model,
          latencyMs: 5,
        });
      case "fail":
        return Promise.reject(step.error);
      case "hang":
        return new Promise<ChatResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              reject(new AiServiceError(ErrorCodes.CANCELLED, "The AI request was cancelled"));
            },
            { once: true },
          );
        });
    }
  }

  healthCheck(): Promise<void> {
    return Promise.resolve();
  }
}

export function reply(content: string, finishReason: FinishReason = "stop"): FakeStep {
  return { kind: "reply", content, finishReason };
}

export function fail(error: Error): FakeStep {
  return { kind: "fail", error };
}
