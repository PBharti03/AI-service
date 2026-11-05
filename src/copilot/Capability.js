import { z } from "zod";
import { checkRequirement } from "../context/Authorization.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { analyticsReportToBlocks, responseBlocksSchema } from "./ResponseBlocks.js";

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

export const CAPABILITY_KINDS = Object.freeze(["data", "analytics", "search", "documents", "knowledge", "calculation"]);
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
});

const capabilities = new WeakSet();

/**
 * @param {{ id: string, kind: string, title: string, description: string, examples?: string[], access: "read", requires?: { permission?: string, feature?: string }, shareFacts?: boolean, timeoutMs?: number, handle: (call: { message: string, context: TrustedContext, history: { role: string, text: string }[], signal: AbortSignal }) => Promise<object> }} definition
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
    handle: async ({ message, context, signal }) => {
      const assistant = await createAssistant(context);
      const report = await assistant.answer({ question: message, context, signal });
      if (report.status === "NOT_ANALYTICS" || report.status === "WRITE_REQUEST" || report.status === "REJECTED") return { status: "NOT_FOUND", blocks: [] };
      const facts = shareFacts
        ? report.sections.filter((section) => shareFacts(section) === true).flatMap((section) => section.observations.map((observation) => observation.text))
        : [];
      return {
        status: report.status === "ANSWERED" ? "ANSWERED" : report.status === "PARTIAL" ? "PARTIAL" : "FAILED",
        blocks: analyticsReportToBlocks(report, { labels, locale }),
        facts: facts.slice(0, 20).map((fact) => fact.slice(0, 300)),
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
