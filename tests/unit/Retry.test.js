import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiServiceError, ErrorCodes } from "../../src/index.js";
import { retryPolicySchema, withRetry } from "../../src/core/Retry.js";
import { expectAiError } from "../helpers/Assertions.js";

const retryable = () => new AiServiceError(ErrorCodes.PROVIDER_TIMEOUT, "timed out", { retryable: true });
const permanent = () => new AiServiceError(ErrorCodes.PROVIDER_HTTP_ERROR, "bad request", { retryable: false });

function recordingWait() {
  const delays = [];
  return {
    delays,
    wait: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  };
}

describe("retry policy", () => {
  it("defaults to zero retries", async () => {
    const policy = retryPolicySchema.parse({});
    assert.equal(policy.maxRetries, 0);
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(retryable());
          },
          policy,
          undefined,
        ),
      ErrorCodes.PROVIDER_TIMEOUT,
    );
    assert.equal(calls, 1);
  });

  it("retries retryable errors up to the bound with exponential delays", async () => {
    const { wait, delays } = recordingWait();
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(retryable());
          },
          { maxRetries: 2, baseDelayMs: 100 },
          undefined,
          wait,
        ),
      ErrorCodes.PROVIDER_TIMEOUT,
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it("stops retrying once an attempt succeeds", async () => {
    const { wait } = recordingWait();
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(retryable()) : Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 0 },
      undefined,
      wait,
    );
    assert.equal(value, "ok");
    assert.equal(calls, 2);
  });

  it("never retries non-retryable or unknown errors", async () => {
    const { wait } = recordingWait();
    let calls = 0;
    await expectAiError(
      () =>
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(permanent());
          },
          { maxRetries: 3, baseDelayMs: 0 },
          undefined,
          wait,
        ),
      ErrorCodes.PROVIDER_HTTP_ERROR,
    );
    assert.equal(calls, 1);

    let plainCalls = 0;
    await assert.rejects(
      withRetry(
        () => {
          plainCalls += 1;
          return Promise.reject(new Error("plain"));
        },
        { maxRetries: 3, baseDelayMs: 0 },
        undefined,
        wait,
      ),
    );
    assert.equal(plainCalls, 1);
  });

  it("is cancelled while waiting between attempts", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);
    const started = Date.now();
    await expectAiError(
      () => withRetry(() => Promise.reject(retryable()), { maxRetries: 3, baseDelayMs: 10_000 }, controller.signal),
      ErrorCodes.CANCELLED,
    );
    assert.ok(Date.now() - started < 5_000);
  });

  it("rejects unbounded policies", () => {
    assert.equal(retryPolicySchema.safeParse({ maxRetries: 4 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ maxRetries: -1 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ baseDelayMs: 60_000 }).success, false);
  });
});
