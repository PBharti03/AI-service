/** Injected fetch that records calls and answers from the handler. Never touches the network. */
export function stubFetch(handler) {
  const calls = [];
  const fetch = (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch, calls };
}

/** A fetch that never answers and rejects only when its signal aborts, like a stalled server. */
export function hangingFetch() {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        },
        { once: true },
      );
    });
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function completionBody(content, overrides = {}) {
  return {
    model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    ...overrides,
  };
}

/** Response streamed in chunks with no Content-Length header, to exercise the streaming size limit. */
export function streamedResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

export function requestBody(init) {
  if (typeof init?.body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(init.body);
}
