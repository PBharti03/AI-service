# @b2y/ai-service

Reusable, task-oriented AI orchestration for B2Y applications, in plain JavaScript (ES modules, no build
step; types are documented with JSDoc).

The package runs **registered tasks** against **one OpenAI-compatible model server** (Groq, or a
self-hosted Ollama/vLLM) and returns **schema-validated JSON** or a typed error. On top of that it offers:

- **Application profiles and chat**: the assistant always speaks as the application that uses the package
  (its own greeting, capabilities and polite answers for topics it does not cover).
- **Text-to-SQL**: the model writes one read-only SELECT, which is parsed with PostgreSQL's own grammar,
  checked against an allow-list policy and parameterised. The application runs it with its own read-only
  database role.
- **Document question answering**: each application adds its own policies, privacy notice, FAQ or
  questionnaires (PDF or text); answers come only from that application's documents, with sources.

It has no database connection, no tools, no agent loop and no automatic fallback to another provider.

Private package, not published.

## Responsibilities

| The application owns | This package owns |
|---|---|
| Authentication, tenant resolution, RBAC, resource ownership | Validating the `TrustedContext` it is given |
| Its application profile and its documents folder | Speaking only as that profile; reading only that application's documents |
| Database connections and a read-only role | Generating and validating SQL; it never executes SQL |
| Quotas, persistence, audit, UI | Usage metadata for metering (`onUsage`), schema-validated output or a typed error |

The package never authenticates anyone, never grants permissions and never reads identity from prompts,
task input or model output.

## Usage

Works with `import` and, on Node.js 20.19+, with `require` (`require(esm)`).

```js
const {
  createAiService, createOpenAICompatibleProvider, createTaskRegistry,
  defineApplicationProfile, createChatAssistant, ASSISTANT_CHAT_TASK, ASSISTANT_CHAT_TASK_ID,
  createFolderDocumentStore, createDocumentQaAgent, DOCUMENT_ANSWER_TASK, DOCUMENT_ANSWER_TASK_ID,
} = require("@b2y/ai-service");

const profile = defineApplicationProfile({
  id: "ecommerce", // must equal the trusted context's applicationId
  name: "B2Y Shop",
  description: "An online shop selling home goods.",
  capabilities: ["order help", "return, refund and shipping policy questions"],
  outOfScope: ["lead statistics"],
});

const ai = createAiService({
  provider: createOpenAICompatibleProvider({
    id: "groq", kind: "PAID", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b",
    apiKey: process.env.GROQ_API_KEY, timeoutMs: 60_000, allowedClassifications: ["SYNTHETIC", "INTERNAL"],
    structuredOutput: "json_schema",
  }),
  registry: createTaskRegistry([ASSISTANT_CHAT_TASK, DOCUMENT_ANSWER_TASK]),
  allowPaidProvider: true,
});

const chat = createChatAssistant({ ai, profile });
const documents = createDocumentQaAgent({ ai, profile, store: createFolderDocumentStore({ root: "/var/lib/shop/ai-documents" }) });

// context comes from the app's authenticated request, never from the client or the model
const context = { applicationId: "ecommerce", tenantId: "t1", actor: { type: "USER", userId: "u1" }, requestId: "r1",
  permittedTasks: [ASSISTANT_CHAT_TASK_ID, DOCUMENT_ANSWER_TASK_ID], dataClassification: "INTERNAL" };

const found = await documents.answer({ question: "What is the return policy?", context });
if (found.status !== "ANSWERED") {
  const result = await chat.reply({ question: "What is the return policy?", context, documentsAvailable: found.status !== "NO_DOCUMENTS" });
}
```

### Documents

- Add documents with `store.addDocument(applicationId, { title, type, text, fileName })`. Types: `policy`,
  `privacy`, `terms`, `faq`, `questionnaire`, `guide`, `other`. Extract PDF text with
  `extractPdfText(bytes)` from `@b2y/ai-service/documents/pdf` (optional peer dependency `unpdf`, Node.js 22+;
  scanned PDFs without a text layer need OCR first).
- The folder store keeps `<root>/<applicationId>/documents/*.json` and `index.json` (folders 0700, files 0600).
  Any object with the same methods (`addDocument`, `removeDocument`, `listDocuments`, `loadIndex`) can replace it.
- Search is local keyword search (BM25); nothing is embedded or sent anywhere. Only the best matching
  passages (at most 8, 1,500 characters each) go to the model, which must cite them. `NO_DOCUMENTS` and
  unmatched questions return without a model call.
- Isolation: the agent reads only `profile.id`'s documents and refuses a request whose trusted
  `applicationId` is different.

### Text-to-SQL

`defineSqlPolicy({ dialect, schema, policy })` describes the tables and columns the model may see and use;
`createPostgresSqlValidator(policy)` (from `@b2y/ai-service/text-to-sql/postgres`, optional peer dependency
`libpg-query`) checks one statement; `createTextToSqlAgent({ ai, validator })` generates, validates and
retries once. The result is a `ValidatedQuery` (parameterised SQL, row limit applied) for the application's
own read-only executor; check what it returns with `checkQueryResult`.

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

## Scripts

| Command | Purpose |
|---|---|
| `npm run lint` | ESLint (JavaScript recommended rules) |
| `npm test` | `node:test` unit and security tests (no network) |
| `npm run verify` | Lint and tests |

Requires Node.js >= 20.19 (PDF extraction: Node.js 22+).
