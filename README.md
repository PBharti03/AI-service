# @b2y/ai-service

Application-independent AI assistant for B2Y applications, in plain JavaScript (ES modules, JSDoc types,
no build step; `require` works from CommonJS on Node.js 20.19+). Private package, not published.

The package knows no application. Each consumer supplies its trusted context, profile, capabilities,
SQL policy, executor and documents; the package routes with the model, validates everything and fails
closed.

## Layout

```
src/core          AiService (tasks, retries, rate limits, output validation), Context, Errors, Tasks
src/providers     Groq and OpenAI-compatible providers, endpoint policy
src/copilot       createAiAssistant (AI routing), capabilities, response blocks
src/analytics     multi-query planner, result merging, charts and observations
src/sql           SQL policy and the PostgreSQL AST validator
src/documents     document Q&A; folder store and PDF text (subpaths)
src/conversations history, retention, folder store (subpath)
src/ui/react      AssistantChat and styles.css (subpaths)
```

## Assistant

```js
const ai = createAiService({
  provider: createProvider({ type: "groq", apiKey, allowedClassifications: ["INTERNAL"] }), // model defaults to GROQ_DEFAULT_MODEL
  registry: createTaskRegistry([ASSISTANT_ROUTE_TASK, ASSISTANT_RESPOND_TASK, ANALYTICS_PLAN_TASK]),
  allowPaidProvider: true,
});
const assistant = createAiAssistant({ ai, profile, capabilities, history });
const { conversationId, status, blocks } = await assistant.reply({ message, context, conversationId });
```

- **Routing is done by the model**: a granted capability, `general` (answers and advice) or `unsupported`
  (changes to data). Grants are decided in code from the context (`requires: { permission, feature }`);
  the model never sees ungranted capabilities, and any other route falls back to `general`.
- **Capabilities** (`defineCapability`, `createAnalyticsCapability`, `createDocumentsCapability`) are
  read-only. Kinds: data, analytics, search, documents, knowledge, calculation, content. A capability may
  return `memory` (server-only JSON) that it receives back on later turns; analytics uses it to re-plan
  follow-ups with the earlier SQL. `shareFacts` decides which code-computed facts may reach the model.
- **Replies are blocks**: heading, paragraph, bullets, metrics, table, chart, flow, notice, sources. Never
  SQL, internal ids or raw rows.

## Context

```js
const context = {
  applicationId: "ecommerce-admin", tenantId: "t-42", actor: { type: "USER", userId: "u-7" }, requestId: "r-1",
  permittedTasks: ["assistant.route", "assistant.respond", "analytics.plan"],
  dataClassification: "INTERNAL", permissions: ["orders:report"], features: ["orders"],
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
<AssistantChat send={send} loadConversation={load} listConversations={list} />  // "@b2y/ai-service/ui/react" + styles.css
```

Restores the latest server-side conversation, New chat, recent chats, typing indicator, retry. Theme with
`--b2y-ai-*` CSS variables; `.b2y-ai-theme` applies the theme to an application's own layout.

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

Raise the version, `npm run verify`, `npm pack`, copy the tarball into the consumer's `vendor/` and depend
on `"@b2y/ai-service": "file:vendor/b2y-ai-service-<version>.tgz"`. `tests/PublicApi.test.js` pins the
public API.
