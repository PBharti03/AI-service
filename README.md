# @b2y/ai-service

Reusable, task-oriented AI orchestration for B2Y applications.

The package runs **registered tasks** (for example "summarise a lead") against **one self-hosted,
OpenAI-compatible model server** (Ollama for local development, vLLM for production), and returns
**schema-validated JSON** or a typed error. It has no database access, no tools, no agent loop and no
automatic fallback to another provider.

Status: Step 1 (foundation). Private package, not published.

## Responsibilities

| The application backend owns | This package owns |
|---|---|
| Authentication, tenant resolution, RBAC, resource ownership | Validating the `TrustedContext` it is given |
| Fetching data through its own authorized services | Minimizing and framing that data as untrusted input |
| Quotas and concurrency (Redis/BullMQ) | Usage metadata for metering (`onUsage`) |
| Persisting results, audit, UI | Schema-validated output or a typed error |

The package never authenticates anyone, never grants permissions and never reads identity from prompts,
task input or model output.

## Usage (CommonJS)

```js
const { z } = require("zod");
const { createAiService, createTaskRegistry, createOllamaProvider, defineTask } = require("@b2y/ai-service");

const summary = defineTask({
  id: "example.summary",
  version: 1,
  promptVersion: "v1",
  description: "Summarise a note",
  instructions: "Summarise the note in one sentence.",
  dataLabel: "note",
  inputSchema: z.strictObject({ note: z.string().max(4000) }),
  outputSchema: z.strictObject({ summary: z.string().max(300) }),
  generation: { temperature: 0, maxTokens: 200 },
  maxClassification: "SYNTHETIC",
});

const ai = createAiService({
  provider: createOllamaProvider({ baseUrl: "http://localhost:11434/v1", model: "<pinned model tag>" }),
  registry: createTaskRegistry([summary]),
  logger, // optional; b2y-logger compatible; receives metadata only
  onUsage: async (record) => { /* write metering row */ },
});

// context comes from the app's authenticated request or job, never from the client or the model
const result = await ai.runTask(summary, context, { note: "..." }, { signal });
```

## Security controls

- **Trusted context**: strict schema (unknown fields such as `role` are rejected), returned deep-frozen
  so hooks cannot change tenant or actor identity. The task must be in `permittedTasks`, and the data
  classification must be allowed by both the task and the provider, all checked **before** any
  inference call.
- **Providers**: exactly one per service. Its info (kind, classifications) is validated and frozen
  when the service is created, and only that snapshot is used afterwards. `PAID` providers need
  `allowPaidProvider: true`. The Ollama preset accepts `SYNTHETIC` data only.
- **Endpoint policy**:
  - `PAID` providers: HTTPS on the default port to an approved hostname only (`api.groq.com`).
    That hostname cannot be configured as `SELF_HOSTED`.
  - Ollama preset: loopback only (`localhost`, `127.0.0.0/8`, `::1`).
  - Other self-hosted endpoints: the host must be in the administrator `allowedHosts` list. Nothing is
    trusted implicitly, including single-label names and private IPs. Plain HTTP only to allow-listed
    loopback, or to allow-listed private / single-label hosts with `allowInsecurePrivateHttp`; never
    to public hosts.
  - Always refused: metadata, link-local, multicast, unspecified and IPv4-mapped addresses, and
    credentials, queries or fragments in the URL. Redirects are refused.
  - DNS is not resolved: Node's built-in fetch gives no supported way to check the address it
    actually connects to, so only list names whose DNS you control.
- **Credentials**: API keys must be visible ASCII; anything else is a non-retryable `CONFIG_INVALID`.
- **Limits**: request and response byte limits, a per-call timeout, and `AbortSignal` cancellation.
  An abandoned response stream is cancelled.
- **Output**: only a complete (`finish_reason: "stop"`) single JSON document that passes the Zod
  schema and optional `postValidate` is accepted. Nothing is repaired or extracted. Every object in
  a task's output schema must be strict (`z.strictObject`, `additionalProperties: false`);
  `defineTask` refuses other schemas instead of changing them.
- **No tools**: the request type has no tools field, tool-call responses are rejected, and task
  definitions with unknown fields (such as `tools`) are refused.
- **Prompt injection**: data is JSON-encoded inside a single `<untrusted_data>` block with `<`, `>`
  and `&` escaped, and is never placed in the system prompt.
- **No leakage**: errors created by the package carry codes, counts, HTTP status and schema-declared
  paths only. Data-derived keys (for example `z.record` keys) appear as `*`. Underlying errors are
  never kept: `cause` holds only the error type name and a system error code such as `ECONNREFUSED`.
  Logs and usage records contain identifiers and metrics only.
- **Retries**: off by default (`maxRetries: 0`), bounded to 3, and cancellation-aware. Only
  timeouts, HTTP 408/429/5xx and transient network failures (connection refused or reset, socket
  timeouts) are retried; redirects, invalid URLs or headers, TLS errors and invalid output never are.
- **Logging and metering**: a logger that throws cannot replace a task's result or error. If
  `onUsage` fails after a successful task, the task fails with `USAGE_RECORDING_FAILED`; if it fails
  after a failed task, the original error is kept and the metering failure is logged.

## Structured output support

`structuredOutput` is a per-deployment setting: `json_schema`, `json_object` or `none`. Support
differs between Ollama and vLLM versions, so confirm it with the integration tests for the exact
pinned server version. Zod validation always runs, whatever the mode.

## Groq demonstration (synthetic data only)

`examples/LeadSummaryDemo.ts` runs one `lead.summary` task on one synthetic lead with exactly one
request to Groq, using only the public API and the existing OpenAI-compatible adapter (no Groq SDK).

| Setting | Value |
|---|---|
| Provider kind | `PAID`, opted in with `allowPaidProvider: true` |
| Base URL | `https://api.groq.com/openai/v1` (HTTPS, exact host `api.groq.com`) |
| Model | `openai/gpt-oss-20b` |
| API key | `GROQ_API_KEY` environment variable (never hard-coded or printed) |
| Classification | `SYNTHETIC` only (provider and task) |
| Generation | temperature `0.2`, max output tokens `1024` |
| Timeout / retries | 60 s / 0 |
| Output | `json_schema` with `strict: true`, then strict Zod validation |

Required environment variable: `GROQ_API_KEY`.

Run with the key exported in your shell:

```bash
export GROQ_API_KEY="<your key>"
npm run demo:groq
```

Or keep the key in a local, git-ignored `.env` file (copy `.env.example`):

```bash
cp .env.example .env
npm run demo:groq:env
```

The demo prints the HTTP status, the model and finish reason reported by Groq, whether Zod validation
passed, token counts, latency and the validated JSON. On failure it prints the package error code and
Groq's error type and code, never Groq's error message, the request headers or the key.

Restrictions:
- Synthetic data only. Groq is an external hosted service. Real customer or company data must not
  be sent until Groq's data-retention and training terms pass the privacy approval required by the
  architecture; until then the provider stays `SYNTHETIC`-only.
- The paid-provider opt-in is manual and per service. There is no automatic fallback to or from Groq.

Known limitations:
- `openai/gpt-oss-20b` is a reasoning model, and its reasoning counts toward the 1024-token limit.
  If the response is cut off (`finish_reason: "length"`), the task fails closed with
  `OUTPUT_PARSE_FAILED`; it does not return partial output.
- `strict: true` structured output depends on Groq's support for the model; Zod validation always
  runs afterwards.
- Model output is not deterministic. Runs can differ, and only output that passes the schema is
  returned.
- The response's `model` must equal the configured model exactly, or the call fails closed.

## Scripts

| Command | Purpose |
|---|---|
| `npm run typecheck` | Strict TypeScript check of `src` and `tests` |
| `npm run lint` | ESLint with typescript-eslint strict, type-aware rules |
| `npm test` | Compiles to `build/` and runs `node:test` (unit and security; no network) |
| `npm run build` | Emits CommonJS and `.d.ts` files to `dist/` |
| `npm run verify` | All of the above |

Requires Node.js >= 20.19.
