# @b2y/ai-service

Application-independent AI assistant for B2Y applications, in plain JavaScript (ES modules, JSDoc types,
no build step; `require` works from CommonJS on Node.js 20.19+). Private package, not published.

The package knows no application. Each consumer supplies its trusted context, profile, capabilities,
SQL policy, executor and documents; the package routes with the model, validates everything and fails
closed.

## Layout

```
src/core          AiService (tasks, retries, rate limits, output validation), Context, Errors, Tasks
src/providers     Groq and OpenAI-compatible providers, endpoint policy (internal)
src/server        runtime, HTTP endpoints, rate limiter, read-only SQL runner (subpath ./server)
src/copilot       createAiAssistant (AI routing), capabilities, response blocks
src/analytics     multi-query planner, result merging, charts and observations
src/sql           SQL policy and the PostgreSQL AST validator
src/documents     document Q&A; folder store and PDF text (subpaths)
src/conversations history, retention, folder store (subpath)
src/ui/react      AssistantChat, AssistantWidget, API client, Beya's icon, styles.css (subpaths)
```

## Assistant

```js
const ai = createDefaultAiService({ apiKey, tasks: [ASSISTANT_ROUTE_TASK, ASSISTANT_RESPOND_TASK, ANALYTICS_PLAN_TASK] });
const assistant = createAiAssistant({ ai, profile, capabilities, history, requires: { permission: AI_ASSISTANT_PERMISSION, feature: "ACCESS_AI_ASSISTANT" } });
const { conversationId, status, blocks } = await assistant.reply({ message, context, conversationId });
```

- **Routing is done by the model**: a granted capability, `general` (answers and advice) or `unsupported`
  (changes to data). Grants are decided in code from the context (`requires: { permission, feature }`);
  the model never sees ungranted capabilities, and any other route falls back to `general`.
- **Capabilities** (`defineCapability`, `createAnalyticsCapability`, `createDocumentsCapability`) are
  read-only. Kinds: data, analytics, search, documents, knowledge, calculation, content. A capability may
  return `memory` (server-only JSON) that it receives back on later turns; analytics uses it to re-plan
  follow-ups with the earlier SQL. `shareFacts` decides which code-computed facts may reach the model.
- **Polished fallbacks**: requests to change data, and questions outside the user's role or plan, get a
  model-written reply that explains what is possible and offers next steps, never a bare refusal.
- **Name and icon**: the assistant is `ASSISTANT_NAME` (Beya) with the same bot icon in every application;
  applications do not set them (an `avatar` prop can override the icon if ever needed).
- **Search** (`createSearchCapability({ fields, sorts, search })`): the model only turns the message into
  filters over declared fields (validated in code, refinements reuse the previous search); `search()` runs
  the application's own scoped query and returns item cards. Items never reach the model.
- **Unavailable hints**: `unavailableHint` on a capability ("Sign in to see your orders.") replaces the
  role/plan explanation for users who cannot use it.
- **Replies are blocks**: heading, paragraph, bullets, metrics, table, chart, flow, cards (items with image,
  price and an app path or https link), notice, sources. Never SQL, internal ids or raw rows.

## Provider and model

`AI_PROVIDER_CONFIG` (src/core/AiService.js) is the only place that names the provider and model for every
application; provider helpers are internal, so no application can name one. Applications pass only their API
key (`createAiRuntime({ apiKey, tasks, conversationsDir })` on the server). To change provider or model, edit
that configuration and release a new package version.

## Server (`@b2y/ai-service/server`)

```js
const { ai, history } = createAiRuntime({ apiKey, tasks, conversationsDir, retentionDays, logger });
const endpoints = createAssistantEndpoints({ resolve: async (req) => ({ assistant, context }) | null, limiter, logger });
mountAssistantRoutes(router, endpoints); // GET /ai/status, POST /ai/chat, GET /ai/conversations[/:id]
```

`resolve` builds the context with `buildTrustedContext` (global tenant rule: the request's domain tenant must
be the session's tenant) and returns null when the assistant is not available. One error policy: 403 access,
429 limits, 400 input, 502 otherwise, in the `{ status, message, data }` shape. Also `createRateLimiter`,
`runReadOnly(sequelize, sql, { bind | replacements })` and `quoteTables(sequelize, models)`.

## Roles and permissions (global)

Roles and permissions work the same in every B2Y application. Pass the signed-in user's **role permissions as
stored** (`{ Module, Name }` rows, `"Module:Name"` or codes such as `VIEW_USERS`) and the tenant's **plan feature
codes**; capabilities and the assistant require them by the same names. Names are normalized
(`permissionKey`), a name matches in any module unless both sides name one, and a list means "any of".

```js
const context = { ..., permissions: rolePermissions(roleRows), features: enabledFeatureCodes };
defineCapability({ ..., requires: { permission: "Generate Order Report", feature: "ACCESS_ORDER" } });
```

`requires` on `createAiAssistant` (for example `AI_ASSISTANT_PERMISSION`) is checked on every reply and
conversation call before any history or model access.

## Context

```js
const context = {
  applicationId: "ecommerce-admin", tenantId: "t-42", actor: { type: "USER", userId: "u-7" }, requestId: "r-1",
  permittedTasks: ["assistant.route", "assistant.respond", "analytics.plan"],
  dataClassification: "INTERNAL", permissions: ["Order Management:Generate Order Report"], features: ["ACCESS_ORDER"],
};
```

Built by the consumer from its own authenticated request, never from the client or the model. Strict and
frozen; tasks, permissions, features and classification are checked before any model call.

## Analytics

```js
const validator = createPostgresSqlValidator(defineSqlPolicy({ dialect: "postgres", schema, policy })); // "@b2y/ai-service/text-to-sql/postgres"
const analytics = createAnalyticsAssistant({ ai, validator, catalog: defineAnalyticsCatalog({ metrics, dimensions }), executor });
```

The model plans 1-4 statements; each passes the AST validator (allowed tables, columns and values,
parameterised literals, row limit, no joins or UNION unless the policy allows them) before the consumer's
read-only executor runs it. Results are merged, charted and described in code and never reach the model.

## Conversations

```js
const history = createConversationHistory({ store: createFolderConversationStore({ root }), retentionDays: 14 }); // 7-14
scheduleConversationCleanup({ history });
```

Scoped to application, tenant and user from the context. Data-based answers are never shown to the model
again; no credentials or grants are stored. Expired conversations are deleted by the cleanup.

## Chat UI

```jsx
const client = createAssistantClient({ baseUrl, headers: () => ({ Authorization, "tenant-domain": domain }) });
<AssistantWidget client={client} onOpenLink={navigate} />                                   // floating launcher + panel
<AssistantChat send={client.send} loadConversation={client.loadConversation} listConversations={client.listConversations} />
```

Restores the latest server-side conversation, New chat, recent chats, typing indicator, retry. Theme with
`--b2y-ai-*` CSS variables (`--b2y-ai-icon-accent` for the bot's teal); the launcher bot tilts, blinks and its
signal pulses, except for users who prefer reduced motion.

## Rate limits

HTTP 429 is `PROVIDER_RATE_LIMITED`. One retry only when Retry-After is at most 5 s; afterwards calls fail
fast without reaching the provider until the wait has passed (at most one minute). Show users
`aiUserMessage(error)`; log `rateLimitInfo(error)`.

## Security

- Only read-only capabilities; the model never chooses tenant, scope or permissions.
- Untrusted data is JSON-encoded in one `<untrusted_data>` block; output must be a complete JSON document
  matching a strict schema.
- Paid providers only on approved hosts (`api.groq.com`), HTTPS, no redirects; request and response size
  limits and timeouts.
- Errors and logs carry codes, counts and statuses only, never prompts, output or credentials.

## Install and verify

Raise the version, `npm run verify` (lint), `npm pack`, copy the tarball into the consumer's `vendor/` and
depend on `"@b2y/ai-service": "file:vendor/b2y-ai-service-<version>.tgz"`.
