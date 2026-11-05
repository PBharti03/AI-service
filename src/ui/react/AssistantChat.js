import { createElement as h, useCallback, useEffect, useRef, useState } from "react";

/**
 * Reusable chat UI for createAiAssistant replies (React 18+, no other dependency, no build step).
 * The application supplies placement, theme (CSS variables, see styles.css) and its authenticated API
 * calls (`send`, and optionally `loadConversation` and `listConversations`); this component handles the
 * conversation, restoring the user's chat from the server, the typing indicator, errors with retry, and
 * rendering of reply blocks. All text is rendered as escaped React text.
 */

const DEFAULT_LABELS = {
  title: "AI Assistant",
  subtitle: "Ask anything: questions about your data, advice or general topics.",
  placeholder: "Ask a question",
  send: "Send",
  retry: "Try again",
  newChat: "New chat",
  history: "Recent chats",
  noHistory: "No recent chats",
  loading: "Loading your conversation",
  error: "The assistant could not answer. Please try again.",
  typing: "Assistant is typing",
  hint: "Enter to send, Shift + Enter for a new line",
  untitled: "Conversation",
  truncated: "Showing the first rows.",
  sources: "Sources",
};
const SERIES_COLORS = ["var(--b2y-ai-accent, #4f46e5)", "#0f9d8a", "#e8590c", "#7048e8", "#d6336c", "#2b8a3e"];

const formatValue = (value) => (typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value === null || value === undefined ? "–" : String(value));
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const toViewMessages = (loaded) => (Array.isArray(loaded) ? loaded : []).filter((message) => message && (message.role === "user" || message.role === "assistant")).map((message) => ({ role: message.role, text: String(message.text ?? ""), blocks: Array.isArray(message.blocks) ? message.blocks : [] }));

const icon = (paths, size = 16) => h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" }, ...paths.map((d, index) => h("path", { key: index, d })));
const SPARK = ["M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z", "M19 15l.8 1.9 1.9.8-1.9.8L19 20.5l-.8-1.9-1.9-.8 1.9-.8z"];
const SEND = ["M5 12h14", "M13 6l6 6-6 6"];
const PLUS = ["M12 5v14", "M5 12h14"];
const CLOCK = ["M12 7v5l3 2", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"];
const ALERT = ["M12 9v4", "M12 17h.01", "M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"];

const Avatar = () => h("span", { className: "b2y-ai-avatar", "aria-hidden": "true" }, icon(SPARK, 15));

/** Three animated dots while the assistant is working. */
export function TypingIndicator({ label = DEFAULT_LABELS.typing }) {
  return h("div", { className: "b2y-ai-typing", role: "status", "aria-label": label }, h("span", null), h("span", null), h("span", null));
}

function Chart({ spec }) {
  if (!spec || !Array.isArray(spec.xLabels) || !Array.isArray(spec.series) || spec.xLabels.length < 2) return null;
  const width = 560;
  const height = 200;
  const pad = { left: 44, right: 8, top: 8, bottom: 28 };
  const values = spec.series.flatMap((series) => series.values);
  const max = Math.max(1, ...values);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = spec.xLabels.length;
  const x = (index) => pad.left + (n === 1 ? innerW / 2 : (index * innerW) / (n - 1));
  const y = (value) => pad.top + innerH - (value / max) * innerH;
  const isLine = spec.chartType === "line" || spec.chartType === "area";
  const every = Math.ceil(n / 8);
  const children = [
    h("line", { key: "grid", x1: pad.left, y1: pad.top, x2: width - pad.right, y2: pad.top, className: "b2y-ai-grid" }),
    h("line", { key: "mid", x1: pad.left, y1: pad.top + innerH / 2, x2: width - pad.right, y2: pad.top + innerH / 2, className: "b2y-ai-grid" }),
    h("line", { key: "axis", x1: pad.left, y1: pad.top + innerH, x2: width - pad.right, y2: pad.top + innerH, className: "b2y-ai-axis" }),
    h("text", { key: "max", x: pad.left - 6, y: pad.top + 4, textAnchor: "end", className: "b2y-ai-tick" }, formatValue(max)),
    ...spec.xLabels.map((label, index) => (index % every === 0 ? h("text", { key: `x${index}`, x: isLine ? x(index) : pad.left + ((index + 0.5) * innerW) / n, y: height - 8, textAnchor: "middle", className: "b2y-ai-tick" }, String(label).slice(0, 12)) : null)),
  ];
  spec.series.forEach((series, seriesIndex) => {
    const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
    if (isLine) {
      children.push(h("polyline", { key: `s${seriesIndex}`, fill: "none", stroke: color, strokeWidth: 2.25, strokeLinejoin: "round", strokeLinecap: "round", points: series.values.map((value, index) => `${x(index)},${y(value)}`).join(" ") }));
    } else {
      const slot = innerW / n;
      const barW = Math.max(2, (slot * 0.7) / spec.series.length);
      series.values.forEach((value, index) => {
        children.push(h("rect", { key: `b${seriesIndex}-${index}`, x: pad.left + index * slot + slot * 0.15 + seriesIndex * barW, y: y(value), width: barW, height: Math.max(0, pad.top + innerH - y(value)), fill: color, rx: 3 }));
      });
    }
  });
  return h(
    "figure",
    { className: "b2y-ai-card b2y-ai-chart" },
    spec.title ? h("figcaption", { className: "b2y-ai-card-title" }, spec.title) : null,
    h("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": spec.title }, ...children),
    spec.series.length > 1 ? h("div", { className: "b2y-ai-legend" }, ...spec.series.map((series, index) => h("span", { key: series.name }, h("i", { style: { background: SERIES_COLORS[index % SERIES_COLORS.length] } }), series.name))) : null,
  );
}

function Block({ block, labels }) {
  switch (block.type) {
    case "heading":
      return h("h4", { className: "b2y-ai-heading" }, block.text);
    case "paragraph":
      return h("p", { className: "b2y-ai-paragraph" }, block.text);
    case "bullets":
      return h("ul", { className: "b2y-ai-bullets" }, ...block.items.map((item, index) => h("li", { key: index }, item)));
    case "metrics":
      return h("div", { className: "b2y-ai-metrics" }, ...block.items.map((item, index) => h("div", { key: index, className: "b2y-ai-metric" }, h("span", { className: "b2y-ai-metric-label" }, item.label), h("span", { className: "b2y-ai-metric-value" }, item.value))));
    case "table":
      return h(
        "div",
        { className: "b2y-ai-card b2y-ai-table-card" },
        h(
          "div",
          { className: "b2y-ai-table-wrap" },
          h("table", { className: "b2y-ai-table" }, h("thead", null, h("tr", null, ...block.columns.map((column, index) => h("th", { key: index }, column)))), h("tbody", null, ...block.rows.map((row, rowIndex) => h("tr", { key: rowIndex }, ...row.map((cell, cellIndex) => h("td", { key: cellIndex, className: typeof cell === "number" ? "b2y-ai-num" : undefined }, formatValue(cell))))))),
        ),
        block.truncated ? h("p", { className: "b2y-ai-muted" }, labels.truncated) : null,
      );
    case "chart":
      return h(Chart, { spec: block.spec });
    case "notice":
      return h("div", { className: `b2y-ai-notice b2y-ai-notice-${block.tone}` }, block.title ? h("strong", null, block.title) : null, h("ul", null, ...block.items.map((item, index) => h("li", { key: index }, item))));
    case "sources":
      return h("div", { className: "b2y-ai-sources" }, h("span", null, `${labels.sources}:`), ...block.items.map((item, index) => (item.url ? h("a", { key: index, href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title) : h("span", { key: index }, item.title))));
    default:
      return null;
  }
}

/** One assistant reply rendered from its blocks. */
export function AssistantMessage({ blocks = [], labels: labelOverrides = {} }) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  return h("div", { className: "b2y-ai-answer" }, ...blocks.map((block, index) => h(Block, { key: index, block, labels })));
}

/**
 * Decides which conversation the chat opens with, from the server only: the given id; none when the id is
 * null (a new chat); otherwise the user's most recent conversation. A conversation the server returns no
 * messages for (expired, deleted or not the user's) starts a new chat. Never throws.
 * @returns {Promise<{ conversationId: string | undefined, messages: { role: string, text: string, blocks: object[] }[], recent: object[] | null }>}
 */
export async function restoreConversation({ conversationId, loadConversation, listConversations }) {
  const fresh = { conversationId: undefined, messages: [], recent: null };
  if (conversationId === null || !loadConversation) return fresh;
  let id = conversationId;
  let recent = null;
  try {
    if (!id && listConversations) {
      const rows = await listConversations();
      recent = Array.isArray(rows) ? rows : [];
      id = recent[0]?.conversationId;
    }
    if (!id) return { ...fresh, recent };
    const messages = toViewMessages(await loadConversation(id));
    return messages.length > 0 ? { conversationId: id, messages, recent } : { ...fresh, recent };
  } catch {
    return { ...fresh, recent };
  }
}

/**
 * Restoring: with `conversationId` the component opens that conversation; with `conversationId` null it
 * starts a new chat; when it is undefined and `listConversations` is given, it reopens the user's most
 * recent conversation from the server (so a refresh, a new tab or a new sign-in continues the chat).
 * The server decides which conversations belong to the user: the component only shows what it returns.
 *
 * @param {{
 *   send: (request: { message: string, conversationId?: string }) => Promise<{ conversationId: string, blocks: object[] }>,
 *   loadConversation?: (conversationId: string) => Promise<{ role: string, text: string, blocks?: object[] }[]>,
 *   listConversations?: () => Promise<{ conversationId: string, title: string, updatedAt: string }[]>,
 *   conversationId?: string | null,
 *   onConversationChange?: (id: string | undefined) => void,
 *   title?: string, intro?: string, suggestions?: string[], labels?: Partial<typeof DEFAULT_LABELS>,
 *   maxLength?: number, className?: string, style?: object,
 * }} props
 */
export function AssistantChat({ send, loadConversation, listConversations, conversationId: initialConversationId, onConversationChange, title, intro, suggestions = [], labels: labelOverrides = {}, maxLength = 4000, className = "", style }) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(initialConversationId || undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(loadConversation && (initialConversationId || (initialConversationId === undefined && listConversations))));
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const loadToken = useRef(0);
  const callbacks = useRef({ loadConversation, listConversations, onConversationChange });
  callbacks.current = { loadConversation, listConversations, onConversationChange };

  /** Opens one conversation from the server; an empty result (expired or not the user's) starts fresh. */
  const open = useCallback(async (id, { notify = true } = {}) => {
    const token = ++loadToken.current;
    const { loadConversation: load, onConversationChange: changed } = callbacks.current;
    if (!id || !load) return;
    setRestoring(true);
    setError(null);
    try {
      const loaded = toViewMessages(await load(id));
      if (token !== loadToken.current) return;
      setMessages(loaded);
      setConversationId(loaded.length > 0 ? id : undefined);
      if (notify) changed?.(loaded.length > 0 ? id : undefined);
    } catch {
      if (token === loadToken.current) setMessages([]);
    } finally {
      if (token === loadToken.current) setRestoring(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = ++loadToken.current;
    const { loadConversation: load, listConversations: list, onConversationChange: changed } = callbacks.current;
    restoreConversation({ conversationId: initialConversationId, loadConversation: load, listConversations: list }).then((restored) => {
      if (cancelled || token !== loadToken.current) return;
      setMessages(restored.messages);
      setConversationId(restored.conversationId);
      if (restored.recent) setRecent(restored.recent);
      setRestoring(false);
      if (restored.conversationId !== (initialConversationId || undefined)) changed?.(restored.conversationId);
    });
    return () => {
      cancelled = true;
    };
  }, [initialConversationId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages, sending, error]);

  const ask = useCallback(
    async (text, { retry = false } = {}) => {
      const message = String(text ?? "").trim();
      if (!message || message.length > maxLength || sending || restoring) return;
      setError(null);
      setSending(true);
      setHistoryOpen(false);
      if (!retry) {
        setMessages((current) => [...current, { role: "user", text: message }]);
        setDraft("");
      }
      try {
        const reply = await send({ message, ...(conversationId ? { conversationId } : {}) });
        if (reply?.conversationId && reply.conversationId !== conversationId) {
          setConversationId(reply.conversationId);
          setRecent(null);
          callbacks.current.onConversationChange?.(reply.conversationId);
        }
        setMessages((current) => [...current, { role: "assistant", blocks: Array.isArray(reply?.blocks) ? reply.blocks : [] }]);
      } catch (failure) {
        setError({ message: (failure && typeof failure.userMessage === "string" && failure.userMessage) || labels.error, retryText: message });
      } finally {
        setSending(false);
        inputRef.current?.focus?.();
      }
    },
    [send, conversationId, sending, restoring, maxLength, labels.error],
  );

  const newChat = () => {
    loadToken.current += 1;
    setMessages([]);
    setError(null);
    setRestoring(false);
    setHistoryOpen(false);
    setConversationId(undefined);
    callbacks.current.onConversationChange?.(undefined);
    inputRef.current?.focus?.();
  };

  const toggleHistory = async () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (opening && listConversations) {
      try {
        const rows = await listConversations();
        setRecent(Array.isArray(rows) ? rows : []);
      } catch {
        setRecent([]);
      }
    }
  };

  const empty = messages.length === 0 && !restoring;
  const header = h(
    "div",
    { className: "b2y-ai-header" },
    h("div", { className: "b2y-ai-title" }, h(Avatar), h("div", null, h("strong", null, title ?? labels.title), h("span", null, labels.subtitle))),
    h(
      "div",
      { className: "b2y-ai-actions" },
      listConversations && loadConversation ? h("button", { type: "button", className: "b2y-ai-ghost", onClick: toggleHistory, "aria-expanded": historyOpen, disabled: sending }, icon(CLOCK, 15), h("span", null, labels.history)) : null,
      h("button", { type: "button", className: "b2y-ai-ghost", onClick: newChat, disabled: sending || (messages.length === 0 && !conversationId) }, icon(PLUS, 15), h("span", null, labels.newChat)),
    ),
    historyOpen
      ? h(
          "div",
          { className: "b2y-ai-history", role: "menu" },
          recent === null ? h(TypingIndicator, { label: labels.loading }) : recent.length === 0 ? h("p", { className: "b2y-ai-muted" }, labels.noHistory) : null,
          ...(recent ?? []).map((row) =>
            h(
              "button",
              { key: row.conversationId, type: "button", role: "menuitem", className: row.conversationId === conversationId ? "b2y-ai-history-item b2y-ai-active" : "b2y-ai-history-item", onClick: () => (setHistoryOpen(false), open(row.conversationId)) },
              h("span", null, row.title || labels.untitled),
              h("time", { dateTime: row.updatedAt }, formatDate(row.updatedAt)),
            ),
          ),
        )
      : null,
  );

  return h(
    "div",
    { className: `b2y-ai-chat ${className}`.trim(), style },
    header,
    h(
      "div",
      { className: "b2y-ai-messages", ref: scrollRef, "aria-live": "polite", "aria-busy": sending || restoring },
      restoring ? h("div", { className: "b2y-ai-restoring" }, h(TypingIndicator, { label: labels.loading }), h("span", null, labels.loading)) : null,
      empty
        ? h(
            "div",
            { className: "b2y-ai-empty" },
            h("span", { className: "b2y-ai-empty-icon", "aria-hidden": "true" }, icon(SPARK, 26)),
            intro ? h("p", { className: "b2y-ai-intro" }, intro) : null,
            suggestions.length > 0 ? h("div", { className: "b2y-ai-suggestions" }, ...suggestions.map((suggestion) => h("button", { key: suggestion, type: "button", onClick: () => ask(suggestion) }, suggestion))) : null,
          )
        : null,
      ...messages.map((message, index) =>
        message.role === "user"
          ? h("div", { key: index, className: "b2y-ai-row b2y-ai-row-user" }, h("p", { className: "b2y-ai-bubble-user" }, message.text))
          : h("div", { key: index, className: "b2y-ai-row b2y-ai-row-assistant" }, h(Avatar), h("div", { className: "b2y-ai-bubble" }, h(AssistantMessage, { labels, blocks: message.blocks?.length ? message.blocks : message.text ? [{ type: "paragraph", text: message.text }] : [] }))),
      ),
      sending ? h("div", { className: "b2y-ai-row b2y-ai-row-assistant" }, h(Avatar), h(TypingIndicator, { label: labels.typing })) : null,
      error
        ? h("div", { className: "b2y-ai-error", role: "alert" }, icon(ALERT, 16), h("span", null, error.message), h("button", { type: "button", onClick: () => ask(error.retryText, { retry: true }), disabled: sending }, labels.retry))
        : null,
    ),
    h(
      "form",
      { className: "b2y-ai-composer", onSubmit: (event) => (event.preventDefault(), ask(draft)) },
      h(
        "div",
        { className: "b2y-ai-input" },
        h("textarea", {
          ref: inputRef,
          value: draft,
          rows: 1,
          maxLength,
          placeholder: labels.placeholder,
          "aria-label": labels.placeholder,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault();
              ask(draft);
            }
          },
        }),
        h("button", { type: "submit", className: "b2y-ai-send", disabled: sending || restoring || draft.trim() === "", "aria-label": labels.send, title: labels.send }, icon(SEND, 18)),
      ),
      h("p", { className: "b2y-ai-hint" }, labels.hint),
    ),
  );
}
