import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { buildSearchIndex } from "./DocumentSearch.js";

/** Kinds of document an application can add. */
export const DOCUMENT_TYPES = ["policy", "privacy", "terms", "faq", "questionnaire", "guide", "other"];
const APPLICATION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DOCUMENTS = 200;

const documentSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  type: z.enum(DOCUMENT_TYPES),
  text: z.string().trim().min(1).max(2_000_000),
  fileName: z.string().trim().min(1).max(200).optional(),
});

/**
 * @typedef {Object} DocumentStore
 * @property {(applicationId: string, document: { title: string, type: string, text: string, fileName?: string }) => Promise<{ id: string, passages: number }>} addDocument
 * @property {(applicationId: string, documentId: string) => Promise<boolean>} removeDocument
 * @property {(applicationId: string) => Promise<{ id: string, title: string, type: string, fileName?: string, addedAt?: string, passages: number }[]>} listDocuments
 * @property {(applicationId: string) => Promise<import("./DocumentSearch.js").SearchIndex | null>} loadIndex
 */

/**
 * Documents and their search index in one private folder per application:
 *   <root>/<applicationId>/documents/<id>.json   title, type, file name and extracted text
 *   <root>/<applicationId>/index.json            search index, rebuilt on every change
 * Folders are created 0700 and files 0600; index writes are atomic. An application id is a plain
 * lower-case name, so it can never point outside its own folder. The store does not decide which
 * application a request belongs to: the document agent passes the trusted context's applicationId.
 * @param {{ root: string }} options
 * @returns {DocumentStore}
 */
export function createFolderDocumentStore({ root }) {
  if (typeof root !== "string" || root.trim() === "")
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A documents root folder is required");
  const base = resolve(root);
  const cache = new Map();

  function appFolder(applicationId) {
    if (typeof applicationId !== "string" || !APPLICATION_ID.test(applicationId)) {
      throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Invalid application id");
    }
    const folder = join(base, applicationId);
    if (!folder.startsWith(base + sep)) throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Invalid application id");
    return folder;
  }

  async function writePrivate(file, contents) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  }

  async function readDocuments(folder) {
    const directory = join(folder, "documents");
    let names;
    try {
      names = (await fs.readdir(directory)).filter(
        (name) => DOCUMENT_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const documents = [];
    for (const name of names.sort()) documents.push(JSON.parse(await fs.readFile(join(directory, name), "utf8")));
    return documents.sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
  }

  async function rebuild(folder) {
    const index = buildSearchIndex(await readDocuments(folder));
    await writePrivate(join(folder, "index.json"), JSON.stringify(index));
    cache.delete(folder);
    return index;
  }

  async function listDocuments(applicationId) {
    const index = await loadIndex(applicationId);
    return index ? index.documents.map((document) => ({ ...document })) : [];
  }

  async function loadIndex(applicationId) {
    const folder = appFolder(applicationId);
    const file = join(folder, "index.json");
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const cached = cache.get(folder);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;
    const index = JSON.parse(await fs.readFile(file, "utf8"));
    cache.set(folder, { mtimeMs: stat.mtimeMs, index });
    return index;
  }

  return Object.freeze({
    async addDocument(applicationId, document) {
      const folder = appFolder(applicationId);
      const parsed = documentSchema.safeParse(document);
      if (!parsed.success) {
        throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Document is invalid", {
          details: summarizeZodError(parsed.error, documentSchema),
        });
      }
      await fs.mkdir(join(folder, "documents"), { recursive: true, mode: 0o700 });
      if ((await readDocuments(folder)).length >= MAX_DOCUMENTS) {
        throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Too many documents for this application", {
          details: { limit: MAX_DOCUMENTS },
        });
      }
      const id = randomUUID();
      const record = { id, ...parsed.data, addedAt: new Date().toISOString() };
      await writePrivate(join(folder, "documents", `${id}.json`), JSON.stringify(record));
      const index = await rebuild(folder);
      return { id, passages: index.documents.find((entry) => entry.id === id)?.passages ?? 0 };
    },

    async removeDocument(applicationId, documentId) {
      const folder = appFolder(applicationId);
      if (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId))
        throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Invalid document id");
      try {
        await fs.unlink(join(folder, "documents", `${documentId}.json`));
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      await rebuild(folder);
      return true;
    },

    listDocuments,

    loadIndex,
  });
}
