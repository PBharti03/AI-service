import "./helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFolderConversationStore } from "../src/conversations/FolderConversationStore.js";
import { createConversationHistory, createMemoryConversationStore, DEFAULT_RETENTION_DAYS, ErrorCodes, scheduleConversationCleanup } from "../src/index.js";
import { makeContext } from "./helpers/Fixtures.js";

// Unit tests of conversation history, isolation and retention (in-memory and local folder stores).

const DAY = 86_400_000;
const ctx = (tenantId = "tenant-0001", userId = "user-0001", applicationId = "example-app") => makeContext({ applicationId, tenantId, actor: { type: "USER", userId }, permissions: ["secret:grant"] });

async function stores() {
  const root = await mkdtemp(join(tmpdir(), "conversations-"));
  return { list: [["memory", createMemoryConversationStore()], ["folder", createFolderConversationStore({ root })]], root };
}

describe("conversation history", () => {
  it("defaults to 14 days, accepts shorter periods and refuses longer or invalid ones", () => {
    const store = createMemoryConversationStore();
    assert.equal(DEFAULT_RETENTION_DAYS, 14);
    assert.equal(createConversationHistory({ store }).retentionDays, 14);
    assert.equal(createConversationHistory({ store, retentionDays: 7 }).retentionDays, 7);
    for (const retentionDays of [0, 6, 15, 7.5, "7"]) {
      assert.throws(() => createConversationHistory({ store, retentionDays }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    }
  });

  it("isolates conversations by application, tenant and user, in every store", async () => {
    const { list, root } = await stores();
    try {
      for (const [name, store] of list) {
        const history = createConversationHistory({ store });
        const id = history.newConversationId();
        await history.append({ context: ctx(), conversationId: id, role: "user", text: "my question", modelVisible: true });
        for (const other of [ctx("tenant-0002"), ctx("tenant-0001", "user-0002"), ctx("tenant-0001", "user-0001", "other-app")]) {
          assert.deepEqual(await history.load({ context: other, conversationId: id }), [], name);
          assert.deepEqual(await history.list({ context: other }), [], name);
          assert.equal(await history.remove({ context: other, conversationId: id }), false, name);
        }
        assert.equal((await history.load({ context: ctx(), conversationId: id })).length, 1, name);
        assert.equal((await history.list({ context: ctx() }))[0].title, "my question", name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores no grants or credentials, only scope ids, text and metadata", async () => {
    const store = createMemoryConversationStore();
    const history = createConversationHistory({ store });
    const id = history.newConversationId();
    const message = await history.append({ context: ctx(), conversationId: id, role: "assistant", text: "Answer", modelVisible: false });
    assert.deepEqual(Object.keys(message).sort(), ["applicationId", "blocks", "conversationId", "createdAt", "messageId", "modelVisible", "role", "route", "status", "tenantId", "text", "userId"]);
    assert.ok(!JSON.stringify(await store.listMessages({ scope: { applicationId: "example-app", tenantId: "tenant-0001", userId: "user-0001" }, conversationId: id, limit: 10 })).includes("secret:grant"));
  });

  it("keeps the application's display data for its server, never for the model, and bounds its size", async () => {
    const { list, root } = await stores();
    try {
      for (const [, store] of list) {
        const history = createConversationHistory({ store });
        const id = history.newConversationId();
        const appData = { type: "flowchart", answer: "Steps", flowchart: { nodes: [{ id: "n1", label: "Start" }] } };
        await history.append({ context: ctx(), conversationId: id, role: "assistant", text: "Steps", modelVisible: true, appData });
        const [loaded] = await history.load({ context: ctx(), conversationId: id });
        assert.deepEqual(loaded.appData, appData);
        assert.deepEqual(history.forModel([loaded]), [{ role: "assistant", text: "Steps" }]);
        await assert.rejects(history.append({ context: ctx(), conversationId: id, role: "assistant", text: "x", modelVisible: false, appData: { big: "x".repeat(70_000) } }), (error) => error.code === ErrorCodes.INPUT_INVALID);
        await assert.rejects(history.append({ context: ctx(), conversationId: id, role: "assistant", text: "x", modelVisible: false, appData: { fn: () => 1 } }));
        await assert.rejects(history.append({ context: ctx(), conversationId: "../escape", role: "user", text: "x", modelVisible: true }), (error) => error.code === ErrorCodes.INPUT_INVALID);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes conversations inactive longer than the retention period, and keeps recent ones", async () => {
    const { list, root } = await stores();
    try {
      for (const [name, store] of list) {
        let clock = new Date("2026-11-01T10:00:00Z");
        const history = createConversationHistory({ store, retentionDays: 7, now: () => clock });
        const old = history.newConversationId();
        await history.append({ context: ctx(), conversationId: old, role: "user", text: "old", modelVisible: true });
        clock = new Date(clock.getTime() + 6 * DAY);
        const recent = history.newConversationId();
        await history.append({ context: ctx(), conversationId: recent, role: "user", text: "recent", modelVisible: true });
        clock = new Date(clock.getTime() + 2 * DAY); // old is now 8 days inactive, recent 2 days
        assert.deepEqual(await history.load({ context: ctx(), conversationId: old }), [], `${name}: expired conversations read as gone`);
        const { deleted } = await history.cleanupExpiredConversations();
        assert.equal(deleted, 1, name);
        assert.equal((await history.load({ context: ctx(), conversationId: recent })).length, 1, name);
        assert.deepEqual((await history.list({ context: ctx() })).map((row) => row.title), ["recent"], name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the folder store keeps private files and refuses ids that are not conversation ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversations-"));
    try {
      const store = createFolderConversationStore({ root });
      const history = createConversationHistory({ store });
      const id = history.newConversationId();
      await history.append({ context: ctx(), conversationId: id, role: "user", text: "q", modelVisible: true });
      const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])))).flat();
      const [file] = await walk(root);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(await history.load({ context: ctx(), conversationId: "../../etc/passwd" }), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("model history shows user messages and safe answers, with data answers replaced", () => {
    const history = createConversationHistory({ store: createMemoryConversationStore(), maxModelMessages: 4 });
    const messages = [
      { role: "user", text: "q1", modelVisible: true },
      { role: "assistant", text: "Repairs: 7,431", modelVisible: false },
      { role: "user", text: "q2", modelVisible: true },
      { role: "assistant", text: "General advice", modelVisible: true },
    ];
    assert.deepEqual(history.forModel(messages).map((message) => message.text), ["q1", "[An earlier answer based on application data, not shown here.]", "q2", "General advice"]);
  });

  it("the optional cleanup helper runs at once, then on an unref'd interval, and can be stopped", async () => {
    let runs = 0;
    const job = scheduleConversationCleanup({ history: { cleanupExpiredConversations: async () => ({ deleted: (runs += 1) }) }, intervalMs: 60_000 });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(runs, 1);
    job.stop();
    assert.throws(() => scheduleConversationCleanup({ history: {}, intervalMs: 60_000 }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
    assert.throws(() => scheduleConversationCleanup({ history: { cleanupExpiredConversations: async () => ({}) }, intervalMs: 1000 }), (error) => error.code === ErrorCodes.CONFIG_INVALID);
  });
});
