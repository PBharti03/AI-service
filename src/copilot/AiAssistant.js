import { randomUUID } from "node:crypto";
import { assertProfileMatchesContext, isApplicationProfile } from "../assistant/ApplicationProfile.js";
import { parseTrustedContext } from "../context/TrustedContext.js";
import { AiServiceError, errorCategory } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { noopLogger } from "../core/Logger.js";
import { EMPTY_TOKEN_USAGE } from "../usage/Usage.js";
import { blocksToText } from "../conversations/ConversationHistory.js";
import { capabilityResultSchema, isCapability, isCapabilityGranted } from "./Capability.js";
import { ASSISTANT_RESPOND_TASK, ASSISTANT_ROUTE_TASK, BUILT_IN_ROUTES } from "./CopilotTasks.js";
import { isResearchProvider } from "./Research.js";
import { responseBlocksSchema } from "./ResponseBlocks.js";

/**
 * The application-agnostic assistant ("copilot"). For each message it:
 *   1. checks the trusted context against the application profile (one application per assistant),
 *   2. loads the user's recent conversation (tenant- and user-scoped) when a history is configured,
 *   3. works out, in code, which of the application's capabilities this user is granted,
 *   4. asks the model to route the message: a granted capability, general reasoning/advice, research
 *      (only with a research provider) or unsupported. The model cannot pick anything else: an unknown or
 *      ungranted route falls back to general reasoning,
 *   5. runs the capability (read-only, with a timeout) or writes the answer with the model, grounding
 *      advice in facts that the application chose to share,
 *   6. returns blocks a UI can render (no SQL, tool names or raw data dumps) and stores the exchange.
 * The model never decides authorization and never receives credentials or unshared data.
 */

const MAX_MESSAGE_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;

const addCount = (a, b) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const addUsage = (total, next) => ({
  promptTokens: addCount(total.promptTokens, next.promptTokens),
  completionTokens: addCount(total.completionTokens, next.completionTokens),
  totalTokens: addCount(total.totalTokens, next.totalTokens),
  latencyMs: total.latencyMs + next.latencyMs,
  attempts: total.attempts + next.attempts,
});

class DeadlineReached extends Error {}
function withTimeout(promise, ms) {
  let timer;
  promise.catch(() => {});
  return Promise.race([promise, new Promise((_resolve, reject) => (timer = setTimeout(() => reject(new DeadlineReached()), ms)))]).finally(() => clearTimeout(timer));
}

function applicationForPrompt(profile) {
  return {
    name: profile.name,
    description: profile.description,
    domain: profile.domain ?? null,
    capabilities: [...profile.capabilities],
    outOfScope: [...profile.outOfScope],
    terminology: profile.terminology.map((entry) => ({ ...entry })),
  };
}

/** Errors the user should retry (provider busy, timeouts) propagate; others become a friendly notice. */
const mustPropagate = (error) => error instanceof AiServiceError && ["rate_limit", "provider", "cancelled", "context", "configuration"].includes(errorCategory(error));

/**
 * @param {{ ai: AiService, profile: ApplicationProfile, capabilities?: readonly object[], history?: object, research?: object, timeoutMs?: number, logger?: object }} options
 */
export function createAiAssistant({ ai, profile, capabilities = [], history, research, timeoutMs = DEFAULT_TIMEOUT_MS, logger = noopLogger }) {
  if (typeof ai?.runTask !== "function" || !isApplicationProfile(profile)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createAiAssistant needs an AiService and a profile from defineApplicationProfile()");
  }
  if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "capabilities must be created with defineCapability()");
  const ids = capabilities.map((capability) => capability.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => BUILT_IN_ROUTES.includes(id))) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Capability ids must be unique and not general, research or unsupported");
  if (history !== undefined && typeof history?.load !== "function") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "history must come from createConversationHistory()");
  if (research !== undefined && !isResearchProvider(research)) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "research must come from defineResearchProvider()");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "timeoutMs must be 1000-180000");
  const application = applicationForPrompt(profile);
  const log = (level, message, meta) => {
    try {
      logger[level](message, meta);
    } catch {
      // Logging is best-effort.
    }
  };

  async function runCapability(capability, call) {
    const controller = new AbortController();
    const signal = call.signal ? AbortSignal.any([controller.signal, call.signal]) : controller.signal;
    try {
      const raw = await withTimeout(Promise.resolve().then(() => capability.handle({ ...call, signal })), capability.timeoutMs);
      const parsed = capabilityResultSchema.safeParse(raw);
      if (!parsed.success) throw new AiServiceError(ErrorCodes.CAPABILITY_FAILED, "The capability returned an invalid result", { details: { capability: capability.id } });
      return { ...parsed.data, facts: capability.shareFacts ? parsed.data.facts : [] };
    } catch (error) {
      controller.abort();
      if (mustPropagate(error)) throw error;
      const code = error instanceof DeadlineReached ? ErrorCodes.CAPABILITY_TIMEOUT : error instanceof AiServiceError ? error.code : ErrorCodes.CAPABILITY_FAILED;
      log("warn", "Assistant capability failed", { capability: capability.id, code });
      return {
        status: "FAILED",
        blocks: [{ type: "notice", tone: "warning", items: [code === ErrorCodes.CAPABILITY_TIMEOUT ? `${capability.title} took too long to answer. Please try again.` : `${capability.title} could not answer right now. Please try again.`] }],
        facts: [],
        sources: [],
      };
    }
  }

  /**
   * @param {{ message: string, context: TrustedContextInput, conversationId?: string, signal?: AbortSignal }} request
   */
  async function reply(request) {
    const context = parseTrustedContext(request.context);
    assertProfileMatchesContext(profile, context);
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (message === "" || message.length > MAX_MESSAGE_CHARS) throw new AiServiceError(ErrorCodes.INPUT_INVALID, `A message is 1-${String(MAX_MESSAGE_CHARS)} characters`);
    const started = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
    let usage = { ...EMPTY_TOKEN_USAGE, latencyMs: 0, attempts: 0 };
    let containsInstructionsToAI = false;
    const runTask = async (task, input) => {
      const result = await ai.runTask(task, context, input, { signal });
      usage = addUsage(usage, result.usage);
      containsInstructionsToAI ||= result.output.containsInstructionsToAI === true;
      return result.output;
    };

    // Conversation: only this user's, in this tenant and application.
    let conversationId = request.conversationId;
    let earlier = [];
    if (history) {
      earlier = history.isConversationId(conversationId) ? await history.load({ context, conversationId }) : [];
      if (earlier.length === 0) conversationId = history.newConversationId();
    } else if (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/.test(conversationId)) {
      conversationId = randomUUID();
    }
    const modelHistory = history ? history.forModel(earlier) : [];

    // Authorization is decided here, from the trusted context: the model only sees granted capabilities.
    const granted = capabilities.filter((capability) => isCapabilityGranted(capability, context));
    const unavailable = capabilities
      .filter((capability) => !granted.includes(capability))
      .map((capability) => ({ title: capability.title, reason: capability.requires.permission !== undefined && !(context.permissions ?? []).includes(capability.requires.permission) ? "not permitted" : "not enabled" }));
    const byId = new Map(granted.map((capability) => [capability.id, capability]));

    const routing = await runTask(ASSISTANT_ROUTE_TASK, {
      application,
      question: message,
      history: modelHistory,
      capabilities: granted.map(({ id, kind, title, description, examples }) => ({ id, kind, title, description, examples: [...examples] })),
      unavailable,
      researchAvailable: research !== undefined,
    });
    const allowedRoutes = new Set([...byId.keys(), "general", "unsupported", ...(research ? ["research"] : [])]);
    let route = allowedRoutes.has(routing.route) ? routing.route : "general";
    const dataNeeded = [...new Set(routing.dataNeeded)].filter((id) => byId.has(id) && byId.get(id).shareFacts).slice(0, 2);

    let status = "ANSWERED";
    let blocks;
    let sources = [];
    let dataBased = false;
    const respond = async ({ facts = [], dataResultsShown = false, researchItems = [] }) => {
      const output = await runTask(ASSISTANT_RESPOND_TASK, {
        application,
        question: message,
        history: modelHistory,
        facts,
        dataResultsShown,
        research: researchItems,
        freshInformationRequested: routing.freshInformation === true,
        unavailable,
      });
      return output.blocks.map((block) => (block.type === "bullets" ? { type: "bullets", items: block.items } : { type: block.type, text: block.text }));
    };

    if (byId.has(route)) {
      const capability = byId.get(route);
      const result = await runCapability(capability, { message, context, history: modelHistory, signal });
      if (result.status === "NOT_FOUND" && result.blocks.length === 0) {
        // The capability had nothing for this message: answer it as a general question instead.
        route = "general";
        blocks = await respond({});
      } else {
        status = result.status;
        blocks = result.blocks;
        sources = result.sources;
        dataBased = true;
      }
    } else if (route === "general") {
      const facts = [];
      const dataBlocks = [];
      for (const id of dataNeeded) {
        const result = await runCapability(byId.get(id), { message, context, history: modelHistory, signal });
        if (result.facts.length > 0) facts.push({ source: byId.get(id).title, items: result.facts });
        dataBlocks.push(...result.blocks.filter((block) => block.type !== "paragraph"));
      }
      dataBased = facts.length > 0 || dataBlocks.length > 0;
      blocks = [...(await respond({ facts, dataResultsShown: dataBlocks.length > 0 })), ...dataBlocks];
    } else if (route === "research") {
      const found = await research.search({ query: message, context, limit: 6, signal }).catch((error) => {
        if (mustPropagate(error)) throw error;
        log("warn", "Assistant research failed", { code: error?.code ?? "RESEARCH_FAILED" });
        return [];
      });
      const researchItems = found.map((item, index) => ({ id: `s${index + 1}`, title: item.title, snippet: item.snippet, publishedAt: item.publishedAt ?? null }));
      blocks = await respond({ researchItems });
      if (found.length > 0) sources = found.map((item) => ({ title: item.title, ...(item.url ? { url: item.url } : {}) }));
      else blocks.push({ type: "notice", tone: "info", items: ["External research is unavailable right now, so this answer uses general knowledge only."] });
    } else {
      status = "UNSUPPORTED";
      const offered = granted.map((capability) => capability.title.toLowerCase());
      blocks = [
        { type: "paragraph", text: "I can't do that here. Changes to your data have to be made in the application itself." },
        { type: "paragraph", text: `I can help with ${[...offered, "questions, explanations and advice"].join(", ")}.`.slice(0, 2000) },
      ];
    }
    if (sources.length > 0 && !blocks.some((block) => block.type === "sources")) blocks.push({ type: "sources", items: sources.slice(0, 8) });
    blocks = responseBlocksSchema.parse(blocks.slice(0, 30));

    if (history) {
      await history.append({ context, conversationId, role: "user", text: message, modelVisible: true });
      await history.append({ context, conversationId, role: "assistant", text: blocksToText(blocks), blocks, route, status, modelVisible: !dataBased });
    }
    log("info", "Assistant replied", { route, status, dataBased, capabilities: granted.length, latencyMs: Date.now() - started });
    return Object.freeze({ conversationId, status, route: byId.has(route) ? "capability" : route, blocks, usage, containsInstructionsToAI });
  }

  const requireHistory = () => {
    if (!history) throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "No conversation history is configured");
    return history;
  };

  return Object.freeze({
    reply,
    /** The user's recent conversations (title and last activity). */
    listConversations: ({ context, limit }) => requireHistory().list({ context, limit }),
    /** One conversation's messages for the UI (text and blocks). */
    loadConversation: async ({ context, conversationId }) => (await requireHistory().load({ context, conversationId })).map(({ role, text, blocks, createdAt }) => ({ role, text, blocks, createdAt })),
    deleteConversation: ({ context, conversationId }) => requireHistory().remove({ context, conversationId }),
    cleanupExpiredConversations: () => requireHistory().cleanupExpiredConversations(),
  });
}
