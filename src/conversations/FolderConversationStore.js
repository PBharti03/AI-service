import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { AiServiceError } from "../core/Errors.js";
import { ErrorCodes } from "../core/Errors.js";
import { defineConversationStore } from "./ConversationHistory.js";

/**
 * A simple local conversation store: one private file per conversation under
 *   <root>/<hash(applicationId)>/<hash(tenantId)>/<hash(userId)>/<conversationId>.json
 * (folders 0700, files 0600, atomic writes). Ids are hashed into folder names, so no id can point outside
 * its folder. For one server instance; several instances need a shared store (a database) instead.
 */

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

export function createFolderConversationStore({ root }) {
  if (typeof root !== "string" || root.trim() === "") throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "A conversations root folder is required");
  const base = resolve(root);
  const folderOf = (scope) => join(base, hash(scope.applicationId), hash(scope.tenantId), hash(scope.userId));
  const fileOf = (scope, conversationId) => {
    if (!CONVERSATION_ID.test(conversationId)) throw new AiServiceError(ErrorCodes.INPUT_INVALID, "Invalid conversation id");
    return join(folderOf(scope), `${conversationId}.json`);
  };
  const read = async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const write = async (file, value) => {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  };
  /** Every conversation file under root, without following links. */
  async function* walk(dir, depth = 0) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) yield* walk(path, depth + 1);
      else if (entry.isFile() && depth === 3 && entry.name.endsWith(".json")) yield path;
    }
  }

  return defineConversationStore({
    async appendMessage(message) {
      const scope = { applicationId: message.applicationId, tenantId: message.tenantId, userId: message.userId };
      await fs.mkdir(folderOf(scope), { recursive: true, mode: 0o700 });
      const file = fileOf(scope, message.conversationId);
      const current = (await read(file)) ?? { conversationId: message.conversationId, messages: [] };
      current.messages.push(message);
      current.updatedAt = message.createdAt;
      await write(file, current);
    },
    async listMessages({ scope, conversationId, limit }) {
      const current = await read(fileOf(scope, conversationId));
      return current ? current.messages.slice(-limit) : [];
    },
    async listConversations({ scope, limit }) {
      const rows = [];
      let names = [];
      try {
        names = await fs.readdir(folderOf(scope));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const name of names.filter((entry) => CONVERSATION_ID.test(entry.replace(/\.json$/, "")))) {
        const current = await read(join(folderOf(scope), name));
        if (current) rows.push({ conversationId: current.conversationId, title: (current.messages.find((message) => message.role === "user")?.text ?? "").slice(0, 80), updatedAt: current.updatedAt });
      }
      return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
    },
    async deleteConversation({ scope, conversationId }) {
      try {
        await fs.unlink(fileOf(scope, conversationId));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    async deleteInactiveSince({ cutoff }) {
      let deleted = 0;
      for await (const file of walk(base)) {
        const current = await read(file);
        if (!current || typeof current.updatedAt !== "string" || current.updatedAt < cutoff) {
          await fs.unlink(file).catch(() => {});
          deleted += 1;
        }
      }
      return deleted;
    },
  });
}
