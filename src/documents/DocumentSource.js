import { z } from "zod";
import { parseTrustedContext } from "../context/TrustedContext.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { searchIndex } from "./DocumentSearch.js";

/**
 * Generic document-store contract. The consumer owns storage, retrieval and authorization: it receives
 * the frozen trusted context (application, tenant, actor, permissions) and returns only passages that
 * request may see. The package assumes no filesystem, database or metadata scheme; it validates what
 * the source returns and never sends more than the passages it was given to the model.
 *
 *   count({ context })                               how many documents the context can use (0 = none)
 *   retrieve({ question, context, limit, signal })   the best passages for a question, at most `limit`
 */

export const MAX_PASSAGE_CHARS = 1500;

const passageSchema = z.strictObject({
  documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  title: z.string().trim().min(1).max(120),
  type: z.string().trim().min(1).max(20).optional(),
  text: z.string().trim().min(1).max(MAX_PASSAGE_CHARS),
  score: z.number().finite().optional(),
});

const sources = new WeakSet();

function sourceFailure(code, message, details) {
  return new AiServiceError(code, message, details === undefined ? {} : { details });
}

/**
 * Wraps a consumer's document source: validates its configuration now and every result later.
 * @param {{ count: (call: { context: TrustedContext }) => Promise<number> | number, retrieve: (call: { question: string, context: TrustedContext, limit: number, signal?: AbortSignal }) => Promise<unknown[]> | unknown[] }} definition
 */
export function defineDocumentSource(definition) {
  const { count, retrieve, ...rest } = definition ?? {};
  if (typeof count !== "function" || typeof retrieve !== "function" || Object.keys(rest).length > 0) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A document source is { count, retrieve } functions");
  }

  async function call(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      throw new AiServiceError(ErrorCodes.DOCUMENT_SOURCE_FAILED, "The document source failed", { cause: error });
    }
  }

  const source = Object.freeze({
    async count(context) {
      const parsed = parseTrustedContext(context);
      const value = await call(() => count({ context: parsed }));
      if (!Number.isInteger(value) || value < 0) throw sourceFailure(ErrorCodes.DOCUMENT_SOURCE_INVALID, "The document source returned an invalid count");
      return value;
    },
    async retrieve({ question, context, limit, signal }) {
      const parsed = parseTrustedContext(context);
      const value = await call(() => retrieve({ question, context: parsed, limit, ...(signal ? { signal } : {}) }));
      if (!Array.isArray(value) || value.length > limit) {
        throw sourceFailure(ErrorCodes.DOCUMENT_SOURCE_INVALID, "The document source must return an array of at most `limit` passages", { limit });
      }
      return Object.freeze(
        value.map((item) => {
          const checked = passageSchema.safeParse(item);
          if (!checked.success) throw sourceFailure(ErrorCodes.DOCUMENT_SOURCE_INVALID, "The document source returned an invalid passage", summarizeZodError(checked.error, passageSchema));
          return Object.freeze(checked.data);
        }),
      );
    },
  });
  sources.add(source);
  return source;
}

export function isDocumentSource(value) {
  return typeof value === "object" && value !== null && sources.has(value);
}

/**
 * A document source over this package's local search index (buildSearchIndex / searchIndex). The
 * consumer decides which index a context may use: loadIndex receives the frozen trusted context and
 * returns that index, or null.
 * @param {{ loadIndex: (context: TrustedContext) => Promise<SearchIndex | null> | SearchIndex | null, minCoverage?: number }} options
 */
export function createIndexDocumentSource({ loadIndex, minCoverage = 0.5 } = {}) {
  if (typeof loadIndex !== "function" || typeof minCoverage !== "number" || minCoverage < 0 || minCoverage > 1) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createIndexDocumentSource needs loadIndex(context) and a minCoverage of 0-1");
  }
  return defineDocumentSource({
    count: async ({ context }) => {
      const index = await loadIndex(context);
      return index ? index.documents.length : 0;
    },
    retrieve: async ({ question, context, limit }) => {
      const index = await loadIndex(context);
      if (!index) return [];
      return searchIndex(index, question, { limit, minCoverage }).map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        ...(hit.type ? { type: hit.type } : {}),
        text: hit.text.slice(0, MAX_PASSAGE_CHARS),
        ...(Number.isFinite(hit.score) ? { score: hit.score } : {}),
      }));
    },
  });
}
