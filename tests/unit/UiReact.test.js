// Server-side render tests of the reusable React chat UI (no DOM needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantChat, AssistantMessage, TypingIndicator, restoreConversation } from "../../src/ui/react/AssistantChat.js";

describe("chat UI", () => {
  it("shows a three-dot typing indicator with an accessible label", () => {
    const html = renderToStaticMarkup(h(TypingIndicator, { label: "Assistant is typing" }));
    assert.equal((html.match(/<span><\/span>/g) ?? []).length, 3);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-label="Assistant is typing"/);
  });

  it("animates the dots, and stops for reduced motion", () => {
    const css = readFileSync(new URL("../../src/ui/react/styles.css", import.meta.url), "utf8");
    assert.match(css, /@keyframes b2y-ai-dot/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /\.b2y-ai-chat, \.b2y-ai-theme \{/, "applications can reuse the theme in their own layout");
  });

  it("renders every block type as escaped text", () => {
    const html = renderToStaticMarkup(
      h(AssistantMessage, {
        blocks: [
          { type: "heading", text: "Summary" },
          { type: "paragraph", text: "<script>alert(1)</script>" },
          { type: "bullets", items: ["One", "Two"] },
          { type: "metrics", items: [{ label: "Repairs", value: "7,431" }] },
          { type: "table", columns: ["Month", "Repairs"], rows: [["Oct", 913], ["Nov", null]], truncated: true },
          { type: "chart", spec: { chartType: "line", alternatives: ["line"], initialView: "chart", title: "Trend", xLabels: ["Oct", "Nov"], series: [{ name: "Repairs", values: [913, 4219] }], basis: { kind: "sql", fingerprints: ["a".repeat(64)], generatedAt: "2026-11-05T00:00:00.000Z" } } },
          { type: "notice", tone: "warning", title: "Not answered", items: ["drivers are not linked"] },
          { type: "sources", items: [{ title: "Report", url: "https://example.com/r" }] },
        ],
      }),
    );
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
    for (const part of ["<h4", "<ul", "b2y-ai-metric", "<table", "Showing the first rows", "<svg", "<polyline", "b2y-ai-notice-warning", 'rel="noopener noreferrer"']) assert.ok(html.includes(part), part);
    assert.match(html, /<td>–<\/td>/);
  });

  it("starts with the intro, suggestions and composer, and no typing indicator", () => {
    const html = renderToStaticMarkup(h(AssistantChat, { send: async () => ({ blocks: [] }), intro: "Ask about your fleet.", suggestions: ["Repairs this month"], labels: { send: "Ask" } }));
    assert.match(html, /Ask about your fleet\./);
    assert.match(html, /Repairs this month/);
    assert.match(html, /<textarea/);
    assert.match(html, /aria-label="Ask"/);
    assert.ok(!html.includes("b2y-ai-typing"));
    assert.ok(!html.includes("Recent chats"), "no history button without listConversations");
  });

  it("shows a loading state while it restores, and the history button when the server lists chats", () => {
    const html = renderToStaticMarkup(h(AssistantChat, { send: async () => ({}), loadConversation: async () => [], listConversations: async () => [], intro: "Hi" }));
    assert.match(html, /b2y-ai-restoring/);
    assert.match(html, /Recent chats/);
    assert.ok(!html.includes("Hi</p>"), "no intro while restoring");
    const fresh = renderToStaticMarkup(h(AssistantChat, { send: async () => ({}), loadConversation: async () => [], listConversations: async () => [], conversationId: null, intro: "Hi" }));
    assert.ok(!fresh.includes("b2y-ai-restoring"));
    assert.match(fresh, /Hi<\/p>/);
  });
});

describe("restoring a conversation from the server", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const stored = { [A]: [{ role: "user", text: "Sales last month?" }, { role: "assistant", text: "", blocks: [{ type: "paragraph", text: "12 orders" }] }], [B]: [{ role: "user", text: "Older" }] };
  const load = async (id) => stored[id] ?? [];
  const list = async () => [{ conversationId: A, title: "Sales last month?", updatedAt: "2026-11-05T10:00:00.000Z" }, { conversationId: B, title: "Older", updatedAt: "2026-11-01T10:00:00.000Z" }];

  it("reopens the most recent conversation after a refresh or a new sign-in (no id kept in the browser)", async () => {
    const restored = await restoreConversation({ conversationId: undefined, loadConversation: load, listConversations: list });
    assert.equal(restored.conversationId, A);
    assert.deepEqual(restored.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(restored.messages[1].blocks[0].text, "12 orders");
    assert.equal(restored.recent.length, 2);
  });

  it("continues the conversation it was given", async () => {
    const restored = await restoreConversation({ conversationId: B, loadConversation: load, listConversations: list });
    assert.equal(restored.conversationId, B);
    assert.equal(restored.messages[0].text, "Older");
  });

  it("starts a new chat for null (New chat), unknown or expired ids, failures and users without chats", async () => {
    for (const options of [
      { conversationId: null, loadConversation: load, listConversations: list },
      { conversationId: "33333333-3333-4333-8333-333333333333", loadConversation: load, listConversations: list },
      { conversationId: undefined, loadConversation: load, listConversations: async () => [] },
      { conversationId: undefined, loadConversation: load, listConversations: async () => { throw new Error("401"); } },
      { conversationId: A, loadConversation: async () => { throw new Error("network"); } },
      { conversationId: undefined, loadConversation: load },
    ]) {
      const restored = await restoreConversation(options);
      assert.equal(restored.conversationId, undefined);
      assert.deepEqual(restored.messages, []);
    }
  });
});
