# @b2y/ai-service

Reusable, application-independent AI orchestration for B2Y applications (Lead Tracker, Ecommerce and
future applications), in plain JavaScript: ES modules, no build step, types documented with JSDoc.
Works with `import`, and from CommonJS with `require` on Node.js 20.19+.

The package knows no application: no tables, columns, business terms or storage layout. Each consumer
supplies its context, permissions, catalog, executors and documents; the package supplies validated,
fail-closed building blocks around one model provider.

Private package, not published.

## Architecture

```
consumer backend (authentication, tenancy, RBAC, data access)
   │  trusted context · application profile · SQL policy + catalog · executors · tools · document source
   ▼
@b2y/ai-service
   core         createAiService: task registry, permission + classification checks, prompt framing,
                provider call, strict output validation, retries, metering
   providers    ChatProvider interface ── Groq · Ollama (local) · any OpenAI-compatible server
   tools        defineTool / createToolRegistry: read-only, input-validated, consumer-executed
   analytics    planner task → SQL AST validation → consumer executor → merge, charts, observations
   documents    consumer DocumentSource → passages → cited answers
   assistant    application profile + chat
```

Query results, tool results and document storage never pass through the model except the document
passages a source returns for a question.

## Consumer responsibilities

The package enforces the context and contracts it is given; it never implements the application's own
security. Each consumer is responsible for:

| Responsibility | The consumer does | The package does |
|---|---|---|
| **Authentication** | Signs users in and verifies sessions or tokens | Nothing: it never sees credentials or sessions |
| **Tenant resolution** | Decides which tenant a request belongs to and puts it in `tenantId` | Validates and freezes the context; passes it to tools and document sources |
| **Authorization / RBAC** | Decides what the user may do; lists the AI tasks in `permittedTasks` and grants in `permissions` | Refuses tasks not in `permittedTasks`; refuses tools, analytics or other features whose required permission is missing (`NOT_AUTHORIZED`) |
| **Subscription / feature checks** | Decides the tenant's plan; lists enabled features in `features` | Refuses whatever `requires` a feature that is not listed (`FEATURE_NOT_ENABLED`) |
| **Data classification** | Sets the most sensitive data a request may send to the model | Refuses tasks or providers that do not allow that classification |
| **Database access** | Owns connections and a read-only role; runs only `isValidatedQuery()` statements | Supplies the SQL policy check, parameterisation, row and time limits; never connects to a database |
| **Analytics catalog** | Describes its tables (`defineSqlPolicy`), measures and limitations (`defineAnalyticsCatalog`) | Plans, validates, merges and describes results; never sends results to the model |
| **Document storage and authorization** | Stores documents and returns only the passages the context may see (`defineDocumentSource`) | Validates passages, answers only from them, requires citations, refuses other applications' contexts |
| **Business tools** | Defines each tool, its input schema, required permission or feature, and executor (`defineTool`) | Validates context, requirements, input and result; only read-only tools; results never reach the model |
| **Provider choice and keys** | Picks the provider and keeps its API key secret | Endpoint policy, request limits, typed errors; paid hosts limited to `APPROVED_PAID_HOSTS` |
| **Persistence, audit, quotas, UI** | Stores conversations, enforces quotas, renders answers | Usage metadata (`onUsage`) and typed errors |

Nothing application-specific lives in the package: no tables, columns, business terms, document kinds or
storage layout. Prompts are generic and filled only from what the consumer supplies (profile, schema,
catalog, document titles and types).

## Application context

Every call takes a trusted context built by the consumer from its own authenticated request, never from
the client, a prompt or the model:

```js
const context = {
  applicationId: "ecommerce",            // isolates profiles and documents
  tenantId: "t-42",                      // passed to tools and document sources for scoping
  actor: { type: "USER", userId: "u-7" },
  requestId: "req-123",
  permittedTasks: ["assistant.chat", "documents.answer", "analytics.plan"],
  dataClassification: "INTERNAL",        // the most sensitive data this request may send to the model
  permissions: ["orders:read"],          // optional: what the consumer granted
  features: ["analytics"],               // optional: subscription features enabled for the tenant
};
```

The schema is strict (unknown fields are refused) and the parsed context is frozen. The package never
authenticates or grants anything: `assertAuthorized(context, { permission, feature })`, `hasPermission`
and `hasFeature` only check the consumer's own lists, and a context without them grants nothing.

## Providers

All provider-specific code sits behind the `ChatProvider` interface; consumers only pass a provider to
`createAiService`. `createProvider(config)` builds one from configuration, so switching provider is a
configuration change:

```js
const provider = createProvider({
  type: "groq",                                   // "groq" | "ollama" | "openai-compatible"
  apiKey: process.env.GROQ_API_KEY,
  model: "openai/gpt-oss-120b",
  allowedClassifications: ["SYNTHETIC", "INTERNAL"], // required: there is no default
});
const ai = createAiService({ provider, registry: createTaskRegistry([...tasks]), allowPaidProvider: true });
```

- `groq`: paid, `https://api.groq.com/openai/v1`. Needs `allowPaidProvider: true` on the service.
- `ollama`: local development, loopback only, `SYNTHETIC` data only.
- `openai-compatible`: any other server (`createOpenAICompatibleProvider` options), under the endpoint
  policy below. A new **paid** host must first be added to `APPROVED_PAID_HOSTS` in this package.

Invalid configuration (unknown type or field, missing key or classifications) throws `CONFIG_INVALID`
before any request. HTTP 429 becomes `PROVIDER_RATE_LIMITED` with `details.retryAfterSeconds` (from
`Retry-After`, at most 300).

## Errors

The package throws only `AiServiceError` with a `code` from `ErrorCodes`; `errorCategory(error)` (backed by
`ErrorCategories`) maps it
to `configuration`, `context`, `authorization`, `validation`, `provider`, `rate_limit`, `output`,
`execution`, `cancelled` or `internal` (anything foreign is `internal`). Messages and details carry
codes, counts, statuses and schema paths only, never input values, model output or credentials.

## AI assistant (copilot)

`createAiAssistant` is the main entry point: one assistant per application, answering any message through
the capabilities the application exposes, general reasoning and advice, or optional research.

```js
const assistant = createAiAssistant({
  ai,                      // createAiService({ provider, registry: createTaskRegistry([ASSISTANT_ROUTE_TASK, ASSISTANT_RESPOND_TASK, ...capability tasks]) })
  profile,                 // defineApplicationProfile({ id, name, description, capabilities, domain, terminology })
  capabilities: [sales],   // defineCapability / createAnalyticsCapability / createDocumentsCapability
  history,                 // optional: createConversationHistory({ store, retentionDays })
  research,                // optional: defineResearchProvider({ id, search })
});
const { conversationId, status, blocks } = await assistant.reply({ message, context, conversationId });
```

For each message the assistant:

1. checks the trusted context against the profile, and loads the user's recent conversation;
2. decides **in code** which capabilities the context grants (`requires: { permission, feature }`);
3. asks the model to route the message to a granted capability, `general` reasoning/advice, `research`
   (only when a provider is configured) or `unsupported`. Any other answer falls back to `general`;
4. runs the capability (read-only, with its own timeout and validated result), or writes the answer with
   the model. Advice ("why did sales fall?", "what should I improve?") is grounded in the **facts** of the
   capabilities the router names, but only those whose definition sets `shareFacts`;
5. returns **blocks** (paragraph, heading, bullets, metrics, table, chart, notice, sources) a UI can render.
   Replies never contain SQL, tool names, internal ids or raw JSON.

```js
const sales = createAnalyticsCapability({
  id: "sales", title: "Sales statistics", description: "Orders, revenue, products and stores",
  requires: { permission: "orders:report", feature: "orders" },
  createAssistant: (context) => createAnalyticsAssistant({ ai, validator, catalog, executor: scopedExecutor(context) }),
  shareFacts: (section) => true,   // which result sections' observations may reach the model; omit to share none
});
```

**Security model.** The application stays the source of truth for authentication, tenant, roles,
permissions, subscriptions and ownership. The model never sees ungranted capabilities, cannot choose a
tenant or scope, and cannot run anything that code did not authorise. Only read-only capabilities exist.
Query results reach the model only as facts the application explicitly shares (computed statements,
never rows), and data-based answers are never fed back to the model as history.

## Conversations and retention

```js
const history = createConversationHistory({ store: createMemoryConversationStore(), retentionDays: 7 }); // default 14, at most 14
await history.cleanupExpiredConversations();         // from the application's own daily cron job
scheduleConversationCleanup({ history });             // or: optional unref'd timer, no extra server
```

History is scoped to application, tenant and user from the trusted context; a conversation id from
another user or tenant finds nothing. Stored: scope ids, message text and blocks, route and status. Never
tokens, credentials or context grants. Conversations inactive for longer than the retention period read
as gone and are deleted by cleanup. Stores: `createMemoryConversationStore()` (single process),
`createFolderConversationStore({ root })` from `@b2y/ai-service/conversations/folder` (one server, private
files), or any `defineConversationStore({ appendMessage, listMessages, listConversations, deleteConversation, deleteInactiveSince })`.

Applications with their own reply format can keep it with a message: `history.append({ ..., appData })`
(JSON, at most 64 KiB). `history.load` returns it to the application's server so it can restore its own
screens; it is never shown to the model, and `assistant.loadConversation` does not return it.

## Research

`defineResearchProvider({ id, search })` plugs in a web or knowledge search. Without one, the assistant
says plainly that current information is not available instead of guessing. Answers that use research
cite their sources.

## Chat UI

`@b2y/ai-service/ui/react` (React 18+, optional peer dependency, no other dependency) exports
`AssistantChat`, `AssistantMessage`, `TypingIndicator` and `restoreConversation`; import
`@b2y/ai-service/ui/react/styles.css` and theme it with CSS variables (`--b2y-ai-accent`, `--b2y-ai-text`,
`--b2y-ai-border`, `--b2y-ai-height` ...). The application supplies placement, theme, labels and its own
authenticated API calls; the component handles messages, the three-dot typing indicator, loading and
error states with retry, new chat, recent chats and block rendering (paragraphs, lists, metric cards,
tables, charts, notices, sources).

```jsx
<AssistantChat
  send={({ message, conversationId }) => api.post("/ai/chat", { message, conversationId })}
  loadConversation={(id) => api.get(`/ai/conversations/${id}`)}   // the user's messages, or []
  listConversations={() => api.get("/ai/conversations")}          // the user's recent conversations
/>
```

Chats live on the server (see Conversations), not in the browser: with `listConversations`, the chat
reopens the user's most recent conversation after a refresh, in a new tab or after signing in again.
`conversationId` opens a given conversation, `null` starts a new one; New chat starts a new conversation
on the next message. The server scopes every list and load to the verified application, tenant and user.

## Tool contract

```js
const ordersCount = defineTool({
  name: "orders.count",
  description: "Counts the tenant's orders with a status",
  access: "read",                                   // the only supported value; "write" is refused
  inputSchema: z.strictObject({ status: z.enum(["open", "shipped"]) }),
  outputSchema: z.strictObject({ count: z.number().int() }),   // optional
  requires: { permission: "orders:read", feature: "analytics" }, // optional
  timeoutMs: 5000,                                  // default 5 s, at most 60 s
  execute: async (input, { context, signal }) => ({ count: await myDb.countOrders(context.tenantId, input.status, signal) }),
});
const tools = createToolRegistry([ordersCount]);
const { output } = await tools.run("orders.count", { status: "open" }, context);
```

`run` checks the context, the requirement and the input before `execute` runs; it maps timeouts,
cancellation, failures and invalid or oversized results (64 KiB default) to `TOOL_*` errors, and returns
a detached JSON copy. `tools.list(context)` describes the usable tools with their input as JSON Schema.
Tool results go back to the caller only; the package never sends them to a model.

## Analytics contract

```js
const validator = createPostgresSqlValidator(defineSqlPolicy({ dialect: "postgres", schema, policy })); // from "@b2y/ai-service/text-to-sql/postgres"
const analytics = createAnalyticsAssistant({
  ai,                                   // with ANALYTICS_PLAN_TASK registered
  validator,                            // the consumer's tables, columns, allowed values and rules
  executor: (validatedQuery) => myReadOnlyDb.run(validatedQuery), // must accept only isValidatedQuery()
  catalog: defineAnalyticsCatalog({ metrics, dimensions, limitations, labels, valueLabels, locale }),
  notes,                                // optional facts added to answers, decided from validated queries
  limits: { maxQueries: 4, maxTotalRows: 600, timeoutMs: 15000 }, // these are the maximums
  requires: { feature: "analytics" },   // optional
});
const report = await analytics.answer({ question, context, conversation });
```

The model plans 1-4 independent statements from the question, the policy-filtered schema and the
catalog. Every statement passes the PostgreSQL AST validator (allowed tables, columns and values,
parameterised literals, row limit; joins, set operations and aggregation are policy settings) before the
consumer's executor runs it, one at a time, within the limits. Results are checked, lined up on a shared
key in code, charted and described with evidence-backed observations. Results never reach the model.
Earlier turns' SQL is re-validated on every follow-up. `createAnalyticsRouter({ topicPattern })` routes
messages cheaply without treating every message after an analytics answer as analytics; pass
`generalPattern` for the application's own non-analytics topics.

The single-statement `createTextToSqlAgent` remains available.

## Document-store contract

```js
const source = defineDocumentSource({
  count: async ({ context }) => myStore.count(context.tenantId),
  retrieve: async ({ question, context, limit, signal }) => myStore.search(context.tenantId, question, limit),
  // returns [{ documentId, title, type?, text (≤ 1500 chars), score? }]
});
const documents = createDocumentQaAgent({ ai, profile, source }); // with DOCUMENT_ANSWER_TASK registered
const found = await documents.answer({ question, context });       // ANSWERED | NOT_FOUND | NO_DOCUMENTS
```

The consumer stores, retrieves and authorises; the package validates every passage (unknown fields,
oversized text or too many passages are `DOCUMENT_SOURCE_INVALID`), sends only those passages to the
model, and accepts only answers that cite them. The agent refuses contexts of another application.

Optional building blocks: local keyword search (`buildSearchIndex`, `searchIndex`,
`createIndexDocumentSource({ loadIndex })`), PDF text extraction (`@b2y/ai-service/documents/pdf`,
peer dependency `unpdf`, Node.js 22+) and a simple local filesystem store
(`createFolderDocumentStore({ root, documentTypes })` from `@b2y/ai-service/documents/folder`: one private
folder per application, no tenants; `documentTypes` lists the kinds of document it accepts).

## Minimal example (CommonJS)

```js
const { createAiService, createProvider, createTaskRegistry, defineApplicationProfile, createChatAssistant,
  ASSISTANT_CHAT_TASK, ASSISTANT_CHAT_TASK_ID } = require("@b2y/ai-service");

const ai = createAiService({
  provider: createProvider({ type: "groq", apiKey: process.env.GROQ_API_KEY, model: "openai/gpt-oss-20b", allowedClassifications: ["INTERNAL"] }),
  registry: createTaskRegistry([ASSISTANT_CHAT_TASK]),
  allowPaidProvider: true,
});
const profile = defineApplicationProfile({ id: "ecommerce", name: "B2Y Shop", description: "An online shop selling home goods.", capabilities: ["order help"] });
const chat = createChatAssistant({ ai, profile });

const context = { applicationId: "ecommerce", tenantId: "t-42", actor: { type: "USER", userId: "u-7" }, requestId: "req-1",
  permittedTasks: [ASSISTANT_CHAT_TASK_ID], dataClassification: "INTERNAL" };
const { output } = await chat.reply({ question: "Hello", context, documentsAvailable: false });
```

## Installation

The package is not published. Consumers install a packed tarball that they keep with their own code:
run `npm run verify`, raise the version (`npm version <x.y.z> --no-git-tag-version`), run `npm pack`, copy
`b2y-ai-service-<x.y.z>.tgz` into the consumer (for example `vendor/`) and depend on
`"@b2y/ai-service": "file:vendor/b2y-ai-service-<x.y.z>.tgz"`. Always raise the version when repacking:
npm caches tarballs by version and integrity.

## Public API

Only the root exports and the subpaths `text-to-sql/postgres`, `documents/pdf`, `documents/folder`,
`conversations/folder`, `ui/react` and `ui/react/styles.css` are supported; everything else under `src/` is internal. `tests/unit/PublicApi.test.js` pins the list.

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
- **No model tool calls**: the request type has no tools field, tool-call responses are rejected, and
  task definitions with unknown fields (such as `tools`) are refused. Package tools (`defineTool`) are
  invoked by the consumer's code, are read-only, and their results are never sent to a model.
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
