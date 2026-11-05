import { z } from "zod";
import { chartSpecSchema } from "../analytics/Results.js";
import { checkRequirement } from "../core/Context.js";
import { AiServiceError, ErrorCodes, summarizeZodError } from "../core/Errors.js";

/**
 * The response format every assistant reply uses: a short list of blocks a UI can render without
 * knowing where they came from. Blocks never contain SQL, tool names, internal ids or raw JSON.
 */

const text = (max) => z.string().trim().min(1).max(max);
const cell = z.union([z.string().max(200), z.number().finite(), z.null()]);

export const responseBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("heading"), text: text(120) }),
  z.strictObject({ type: z.literal("paragraph"), text: text(2000) }),
  z.strictObject({ type: z.literal("bullets"), items: z.array(text(400)).min(1).max(12) }),
  z.strictObject({ type: z.literal("metrics"), items: z.array(z.strictObject({ label: text(60), value: text(40) })).min(1).max(8) }),
  z.strictObject({
    type: z.literal("table"),
    title: text(120).optional(),
    columns: z.array(text(60)).min(1).max(8),
    rows: z.array(z.array(cell).max(8)).max(50),
    truncated: z.boolean(),
  }),
  z.strictObject({ type: z.literal("chart"), spec: chartSpecSchema }),
  z.strictObject({ type: z.literal("notice"), tone: z.enum(["info", "warning"]), title: text(80).optional(), items: z.array(text(300)).min(1).max(8) }),
  z.strictObject({
    type: z.literal("flow"),
    title: text(80).optional(),
    nodes: z.array(z.strictObject({ id: z.string().regex(/^n[1-9][0-9]?$/), label: text(80), kind: z.enum(["start", "step", "decision", "end"]) })).min(2).max(30),
    edges: z.array(z.strictObject({ from: z.string().regex(/^n[1-9][0-9]?$/), to: z.string().regex(/^n[1-9][0-9]?$/), label: z.string().trim().max(30) })).max(40),
  }),
  z.strictObject({ type: z.literal("sources"), items: z.array(z.strictObject({ title: text(160), url: z.url().max(500).optional() })).min(1).max(8) }),
]);

export const responseBlocksSchema = z.array(responseBlockSchema).max(30);

const MAX_TABLE_ROWS = 50;

/** "order_value" -> "Order value"; labels win when the application supplied one. */
function columnLabel(name, labels) {
  if (Object.hasOwn(labels, name)) return labels[name];
  const words = String(name).replace(/_/g, " ").trim();
  return words.length === 0 ? String(name) : words[0].toUpperCase() + words.slice(1);
}

const formatCell = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(value)) return value.slice(0, 10);
  return String(value).slice(0, 200);
};

/**
 * Blocks for an analytics report (see createAnalyticsAssistant): the findings first, then per section a
 * metric row (single-row results), a chart when useful, and a table; notes and unanswered parts last.
 * The planner's own explanation and the SQL are never included.
 * @param {object} report
 * @param {{ labels?: Record<string, string>, locale?: string }} [options]
 */
export function analyticsReportToBlocks(report, { labels = {}, locale = "en-US" } = {}) {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const blocks = [];
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const headline = sections.flatMap((section) => section.observations.slice(0, 1).map((observation) => observation.text)).slice(0, 3);
  if (headline.length > 0) blocks.push({ type: "paragraph", text: headline.join(" ").slice(0, 2000) });
  for (const section of sections) {
    if (sections.length > 1) blocks.push({ type: "heading", text: String(section.title).slice(0, 120) });
    const names = section.columns.map((column) => column.name);
    const singleNumbers = section.rows.length === 1 && section.rows[0].every((value) => typeof formatCell(value) === "number");
    if (singleNumbers) {
      blocks.push({ type: "metrics", items: names.slice(0, 8).map((name, index) => ({ label: columnLabel(name, labels).slice(0, 60), value: format.format(formatCell(section.rows[0][index])) })) });
    } else {
      if (section.chart && section.rows.length >= 2) blocks.push({ type: "chart", spec: section.chart });
      blocks.push({
        type: "table",
        columns: names.slice(0, 8).map((name) => columnLabel(name, labels).slice(0, 60)),
        rows: section.rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, 8).map((value) => formatCell(value))),
        truncated: section.truncated === true || section.rows.length > MAX_TABLE_ROWS,
      });
    }
    const more = section.observations.slice(1, 5).map((observation) => observation.text);
    if (more.length > 0) blocks.push({ type: "bullets", items: more });
  }
  const notes = (report.notes ?? []).map((note) => note.text);
  if (notes.length > 0) blocks.push({ type: "notice", tone: "info", items: notes.slice(0, 8) });
  const missing = [
    ...(report.unanswered ?? []).map((item) => `${item.part}: ${item.reason}`),
    ...(report.failures ?? []).map((item) => item.reason),
  ];
  if (missing.length > 0) blocks.push({ type: "notice", tone: "warning", title: "Not answered", items: [...new Set(missing)].slice(0, 8).map((item) => item.slice(0, 300)) });
  return responseBlocksSchema.parse(blocks.slice(0, 30));
}

/**
 * A capability is something the consuming application lets the assistant do for a user: answer data
 * questions, search its records, read its documents, run a business calculation ... The application
 * defines what it exposes and implements `handle`; the package decides when to use it (routing), checks
 * the application's requirement against the trusted context before calling it, and validates its result.
 *
 * Only read-only capabilities exist in this version (`access: "read"`).
 *
 * `shareFacts` is the application's decision about what of a result may reach the model for follow-up
 * reasoning (advice, "why ..." questions): `facts` are short, code-computed statements such as
 * "Sales: 12,400 in Oct 2026 compared with 15,100 in Sep 2026 (-18%)". Never raw rows. Default: nothing.
 */

// "content": generated output such as a flowchart (model-visible later, unlike data results).
export const CAPABILITY_KINDS = Object.freeze(["data", "analytics", "search", "documents", "knowledge", "calculation", "content"]);
const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,63}$/;

const definitionSchema = z.strictObject({
  id: z.string().regex(CAPABILITY_ID),
  kind: z.enum(CAPABILITY_KINDS),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  examples: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
  access: z.literal("read"),
  shareFacts: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60_000).default(20_000),
});

/** What a capability's handle returns. Facts are dropped unless the capability shares them. */
export const capabilityResultSchema = z.strictObject({
  status: z.enum(["ANSWERED", "PARTIAL", "NOT_FOUND", "FAILED"]),
  blocks: responseBlocksSchema.default([]),
  facts: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  sources: z.array(z.strictObject({ title: z.string().trim().min(1).max(160), url: z.url().max(500).optional() })).max(8).default([]),
  /** Server-only data kept with the reply and passed back to this capability on later turns. */
  memory: z.json().optional(),
});

const capabilities = new WeakSet();

/**
 * @param {{ id: string, kind: string, title: string, description: string, examples?: string[], access: "read", requires?: { permission?: string, feature?: string }, shareFacts?: boolean, timeoutMs?: number, handle: (call: { message: string, context: TrustedContext, history: { role: string, text: string }[], memory: { message: string, memory: unknown }[], signal: AbortSignal }) => Promise<object> }} definition
 */
export function defineCapability(definition) {
  if (typeof definition !== "object" || definition === null) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A capability definition must be an object");
  const { requires, handle, ...rest } = definition;
  if (rest.access === "write") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, 'Only read-only capabilities are supported: access must be "read"', { details: { capability: String(rest.id).slice(0, 64) } });
  if (typeof handle !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A capability needs a handle function");
  const parsed = definitionSchema.safeParse(rest);
  if (!parsed.success) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Capability definition is invalid", { details: summarizeZodError(parsed.error, definitionSchema) });
  const capability = Object.freeze({ ...parsed.data, examples: Object.freeze([...parsed.data.examples]), requires: checkRequirement(requires, `Capability ${parsed.data.id}`), handle });
  capabilities.add(capability);
  return capability;
}

export function isCapability(value) {
  return typeof value === "object" && value !== null && capabilities.has(value);
}

/** Whether the trusted context grants the capability's requirement (decided in code, never by the model). */
export function isCapabilityGranted(capability, context) {
  const { permission, feature } = capability.requires;
  return (permission === undefined || (context.permissions ?? []).includes(permission)) && (feature === undefined || (context.features ?? []).includes(feature));
}

/**
 * A capability over an analytics assistant (createAnalyticsAssistant). createAssistant(context) builds
 * the assistant for the request, so the application can scope it to the request's tenant and boundaries.
 * shareFacts(section) decides per result section whether its observations may reach the model.
 */
export function createAnalyticsCapability({ id, title, description, examples, requires, createAssistant, shareFacts, labels, locale, timeoutMs }) {
  if (typeof createAssistant !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createAnalyticsCapability needs createAssistant(context)");
  if (shareFacts !== undefined && typeof shareFacts !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "shareFacts must be a function(section) => boolean");
  return defineCapability({
    id,
    kind: "analytics",
    title,
    description,
    ...(examples ? { examples } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    access: "read",
    requires,
    shareFacts: shareFacts !== undefined,
    handle: async ({ message, context, memory = [], signal }) => {
      const assistant = await createAssistant(context);
      // Earlier questions with their SQL (kept as memory) let follow-ups build on them; re-validated.
      const conversation = memory
        .filter((turn) => Array.isArray(turn.memory?.queries) && turn.memory.queries.length > 0)
        .map((turn) => ({ question: turn.message.slice(0, 2000), queries: turn.memory.queries.filter((sql) => typeof sql === "string").slice(0, 4) }));
      const report = await assistant.answer({ question: message, context, conversation, signal });
      if (report.status === "NOT_ANALYTICS" || report.status === "WRITE_REQUEST" || report.status === "REJECTED") return { status: "NOT_FOUND", blocks: [] };
      const facts = shareFacts
        ? report.sections.filter((section) => shareFacts(section) === true).flatMap((section) => section.observations.map((observation) => observation.text))
        : [];
      return {
        status: report.status === "ANSWERED" ? "ANSWERED" : report.status === "PARTIAL" ? "PARTIAL" : "FAILED",
        blocks: analyticsReportToBlocks(report, { labels, locale }),
        facts: facts.slice(0, 20).map((fact) => fact.slice(0, 300)),
        ...(report.queries?.length > 0 ? { memory: { queries: report.queries.map((query) => query.sql) } } : {}),
      };
    },
  });
}

/** A capability over a document Q&A agent (createDocumentQaAgent). Its answers cite the documents used. */
export function createDocumentsCapability({ id, title, description, examples, requires, agent, shareFacts = false }) {
  if (typeof agent?.answer !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createDocumentsCapability needs a document agent");
  return defineCapability({
    id,
    kind: "documents",
    title,
    description,
    ...(examples ? { examples } : {}),
    access: "read",
    requires,
    shareFacts,
    handle: async ({ message, context, history, signal }) => {
      const found = await agent.answer({ question: message, context, history, signal });
      if (found.status !== "ANSWERED") return { status: "NOT_FOUND", blocks: [] };
      return {
        status: "ANSWERED",
        blocks: [{ type: "paragraph", text: found.answer }, ...(found.sources.length > 0 ? [{ type: "sources", items: found.sources.map((source) => ({ title: source.title })) }] : [])],
        facts: shareFacts ? [found.answer.slice(0, 300)] : [],
        sources: found.sources.map((source) => ({ title: source.title })),
      };
    },
  });
}
