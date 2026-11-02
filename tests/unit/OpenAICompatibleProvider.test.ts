import "../helpers/NoNetwork";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOllamaProvider,
  createOpenAICompatibleProvider,
  ErrorCodes,
  type ChatRequest,
  type ErrorCode,
  type OpenAICompatibleProviderConfig,
  type ProviderDependencies,
} from "../../src";
import { expectAiError } from "../helpers/Assertions";
import {
  completionBody,
  hangingFetch,
  jsonResponse,
  requestBody,
  streamedResponse,
  stubFetch,
} from "../helpers/FetchStubs";

const baseConfig: OpenAICompatibleProviderConfig = {
  id: "test-vllm",
  kind: "SELF_HOSTED",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "test-model",
  allowedHosts: ["127.0.0.1"],
  timeoutMs: 5000,
  allowedClassifications: ["SYNTHETIC"],
  structuredOutput: "json_schema",
};

const request: ChatRequest = {
  messages: [
    { role: "system", content: "Synthetic system prompt" },
    { role: "user", content: "Synthetic user message" },
  ],
  generation: { temperature: 0, maxTokens: 64, seed: 7 },
  jsonSchema: { name: "test_schema", schema: { type: "object", properties: {}, additionalProperties: false } },
};

function provider(overrides: Partial<OpenAICompatibleProviderConfig> = {}, dependencies: ProviderDependencies = {}) {
  return createOpenAICompatibleProvider({ ...baseConfig, ...overrides }, dependencies);
}

describe("OpenAI-compatible provider: requests", () => {
  it("posts a chat completion with schema-constrained output and no tools", async () => {
    const stub = stubFetch(() => jsonResponse(completionBody('{"ok":true}')));
    const result = await provider({}, { fetch: stub.fetch }).complete(request);

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.ok(call);
    assert.equal(call.url, "http://127.0.0.1:8000/v1/chat/completions");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init.redirect, "error");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);

    const body = requestBody(call.init);
    assert.equal(body.model, "test-model");
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 64);
    assert.equal(body.seed, 7);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: { name: "test_schema", schema: request.jsonSchema?.schema, strict: true },
    });
    for (const forbidden of ["tools", "tool_choice", "functions", "function_call"]) {
      assert.equal(forbidden in body, false, `${forbidden} must never be sent`);
    }

    assert.equal(result.content, '{"ok":true}');
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  });

  it("uses json_object or no response_format depending on the configured mode", async () => {
    const jsonObject = stubFetch(() => jsonResponse(completionBody("{}")));
    await provider({ structuredOutput: "json_object" }, { fetch: jsonObject.fetch }).complete(request);
    assert.deepEqual(requestBody(jsonObject.calls[0]?.init).response_format, { type: "json_object" });

    const none = stubFetch(() => jsonResponse(completionBody("{}")));
    await provider({ structuredOutput: "none" }, { fetch: none.fetch }).complete(request);
    assert.equal("response_format" in requestBody(none.calls[0]?.init), false);
  });

  it("sends the API key only as a bearer header", async () => {
    const stub = stubFetch(() => jsonResponse(completionBody("{}")));
    await provider({ apiKey: "synthetic-key-123" }, { fetch: stub.fetch }).complete(request);
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer synthetic-key-123");
  });

  it("maps finish reasons and derives missing totals", async () => {
    const stub = stubFetch(() =>
      jsonResponse(
        completionBody("{}", {
          choices: [{ finish_reason: "length", message: { content: "{" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      ),
    );
    const result = await provider({}, { fetch: stub.fetch }).complete(request);
    assert.equal(result.finishReason, "length");
    assert.equal(result.usage.totalTokens, 7);
  });

  it("refuses requests above the size limit without calling the server", async () => {
    const stub = stubFetch(() => jsonResponse(completionBody("{}")));
    const big: ChatRequest = { ...request, messages: [{ role: "user", content: "x".repeat(4000) }] };
    await expectAiError(
      () => provider({ maxRequestBytes: 1024 }, { fetch: stub.fetch }).complete(big),
      ErrorCodes.REQUEST_TOO_LARGE,
    );
    assert.equal(stub.calls.length, 0);
  });
});

describe("OpenAI-compatible provider: failures", () => {
  it("normalises HTTP errors with retryability and without the response body", async () => {
    const cases: [number, ErrorCode, boolean][] = [
      [400, ErrorCodes.PROVIDER_HTTP_ERROR, false],
      [401, ErrorCodes.PROVIDER_HTTP_ERROR, false],
      [404, ErrorCodes.PROVIDER_HTTP_ERROR, false],
      [408, ErrorCodes.PROVIDER_HTTP_ERROR, true],
      [429, ErrorCodes.PROVIDER_HTTP_ERROR, true],
      [500, ErrorCodes.PROVIDER_HTTP_ERROR, true],
      [503, ErrorCodes.PROVIDER_UNAVAILABLE, true],
    ];
    for (const [status, code, retryable] of cases) {
      const stub = stubFetch(() => jsonResponse({ error: "SYNTHETIC-BODY-CONTENT echo of prompt" }, status));
      const error = await expectAiError(
        () => provider({}, { fetch: stub.fetch }).complete(request),
        code,
      );
      assert.equal(error.retryable, retryable, `status ${String(status)}`);
      assert.equal(error.details.status, status);
      assert.ok(!error.message.includes("SYNTHETIC-BODY-CONTENT"));
      assert.ok(!JSON.stringify(error.details).includes("SYNTHETIC-BODY-CONTENT"));
    }
  });

  it("does not follow redirects", async () => {
    const stub = stubFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    const error = await expectAiError(
      () => provider({}, { fetch: stub.fetch }).complete(request),
      ErrorCodes.PROVIDER_HTTP_ERROR,
    );
    assert.equal(error.retryable, false);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.init?.redirect, "error");
  });

  it("rejects invalid response formats", async () => {
    const cases: [Response, string][] = [
      [new Response("SYNTHETIC not json {", { headers: { "content-type": "application/json" } }), "not_json"],
      [new Response("<html>SYNTHETIC</html>", { headers: { "content-type": "text/html" } }), "content_type"],
      [jsonResponse({ choices: [] }), "shape"],
      [jsonResponse({ unexpected: true }), "shape"],
      [jsonResponse(completionBody(null)), "missing_content"],
      [
        jsonResponse(
          completionBody("{}", {
            choices: [{ finish_reason: "tool_calls", message: { content: "{}", tool_calls: [{ id: "call-1" }] } }],
          }),
        ),
        "tool_calls",
      ],
      [jsonResponse(completionBody("{}", { model: "some-other-model" })), "model_mismatch"],
    ];
    for (const [response, reason] of cases) {
      const stub = stubFetch(() => response);
      const error = await expectAiError(
        () => provider({}, { fetch: stub.fetch }).complete(request),
        ErrorCodes.PROVIDER_RESPONSE_INVALID,
      );
      assert.equal(error.details.reason, reason);
      assert.ok(!error.message.includes("SYNTHETIC"));
    }
  });

  it("enforces the response size limit from Content-Length and while streaming", async () => {
    const declared = stubFetch(() => jsonResponse(completionBody("{}"), 200, { "content-length": "999999" }));
    const first = await expectAiError(
      () => provider({ maxResponseBytes: 1024 }, { fetch: declared.fetch }).complete(request),
      ErrorCodes.PROVIDER_RESPONSE_INVALID,
    );
    assert.equal(first.details.reason, "too_large");

    const streamed = stubFetch(() => streamedResponse(["x".repeat(700), "y".repeat(700)]));
    const second = await expectAiError(
      () => provider({ maxResponseBytes: 1024 }, { fetch: streamed.fetch }).complete(request),
      ErrorCodes.PROVIDER_RESPONSE_INVALID,
    );
    assert.equal(second.details.reason, "too_large");
  });

  it("times out a stalled server as a retryable error", async () => {
    const error = await expectAiError(
      () => provider({ timeoutMs: 100 }, { fetch: hangingFetch() }).complete(request),
      ErrorCodes.PROVIDER_TIMEOUT,
    );
    assert.equal(error.retryable, true);
  });

  it("honours caller cancellation before and during the request", async () => {
    const stub = stubFetch(() => jsonResponse(completionBody("{}")));
    const aborted = new AbortController();
    aborted.abort();
    await expectAiError(
      () => provider({}, { fetch: stub.fetch }).complete(request, { signal: aborted.signal }),
      ErrorCodes.CANCELLED,
    );
    assert.equal(stub.calls.length, 0);

    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);
    const error = await expectAiError(
      () => provider({}, { fetch: hangingFetch() }).complete(request, { signal: controller.signal }),
      ErrorCodes.CANCELLED,
    );
    assert.equal(error.retryable, false);
  });

  it("reports connection failures as retryable unavailability", async () => {
    const refused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const failing: typeof globalThis.fetch = () => Promise.reject(new TypeError("fetch failed", { cause: refused }));
    const error = await expectAiError(
      () => provider({}, { fetch: failing }).complete(request),
      ErrorCodes.PROVIDER_UNAVAILABLE,
    );
    assert.equal(error.retryable, true);
  });

  it("never reaches the network implicitly in unit tests", async () => {
    const error = await expectAiError(() => provider().complete(request), ErrorCodes.PROVIDER_UNAVAILABLE);
    assert.deepEqual(error.cause, { name: "UnexpectedNetworkError" });
  });
});

describe("OpenAI-compatible provider: configuration and health", () => {
  it("rejects invalid configuration without echoing secrets", async () => {
    const error = await expectAiError(
      () => provider({ timeoutMs: 10, apiKey: "synthetic-key-should-not-leak" }),
      ErrorCodes.CONFIG_INVALID,
    );
    assert.ok(!JSON.stringify(error.details).includes("synthetic-key-should-not-leak"));
    await expectAiError(() => provider({ baseUrl: "https://public.example.com/v1" }), ErrorCodes.CONFIG_INVALID);
  });

  it("checks that the configured model is served", async () => {
    const served = stubFetch(() => jsonResponse({ object: "list", data: [{ id: "test-model" }] }));
    await provider({}, { fetch: served.fetch }).healthCheck();
    assert.equal(served.calls[0]?.url, "http://127.0.0.1:8000/v1/models");
    assert.equal(served.calls[0].init?.method, "GET");

    const missing = stubFetch(() => jsonResponse({ object: "list", data: [{ id: "other-model" }] }));
    const error = await expectAiError(
      () => provider({}, { fetch: missing.fetch }).healthCheck(),
      ErrorCodes.PROVIDER_UNAVAILABLE,
    );
    assert.equal(error.details.reason, "model_not_served");
  });

  it("exposes frozen, credential-free provider info", () => {
    const instance = provider({ apiKey: "synthetic-key-123", modelRevision: "rev-abc" });
    assert.ok(Object.isFrozen(instance));
    assert.deepEqual(instance.info, {
      id: "test-vllm",
      kind: "SELF_HOSTED",
      model: "test-model",
      modelRevision: "rev-abc",
      allowedClassifications: ["SYNTHETIC"],
      structuredOutput: "json_schema",
    });
  });
});

describe("Ollama preset", () => {
  it("is self-hosted, synthetic-only and loopback-only over HTTP", async () => {
    const ollama = createOllamaProvider({ baseUrl: "http://localhost:11434/v1", model: "synthetic-model:3b" });
    assert.equal(ollama.info.kind, "SELF_HOSTED");
    assert.deepEqual(ollama.info.allowedClassifications, ["SYNTHETIC"]);
    assert.equal(ollama.info.structuredOutput, "json_schema");
    await expectAiError(
      () => createOllamaProvider({ baseUrl: "http://10.0.0.5:11434/v1", model: "synthetic-model:3b" }),
      ErrorCodes.CONFIG_INVALID,
    );
    await expectAiError(
      () => createOllamaProvider({ baseUrl: "https://ollama.example.com/v1", model: "synthetic-model:3b" }),
      ErrorCodes.CONFIG_INVALID,
    );
  });
});
