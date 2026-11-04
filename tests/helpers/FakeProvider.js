import { AiServiceError, ErrorCodes } from "../../src/index.js";

const DEFAULT_USAGE = { promptTokens: 40, completionTokens: 12, totalTokens: 52 };

/** Scripted provider: each call consumes the next step. Records every request it receives. */
export class FakeProvider {
  info;
  requests = [];
  steps;

  constructor(steps, info = {}) {
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

  complete(request, options = {}) {
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
        return new Promise((_resolve, reject) => {
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

  healthCheck() {
    return Promise.resolve();
  }
}

export function reply(content, finishReason = "stop") {
  return { kind: "reply", content, finishReason };
}

export function fail(error) {
  return { kind: "fail", error };
}
