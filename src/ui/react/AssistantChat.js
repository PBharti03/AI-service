import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import { ASSISTANT_NAME, ASSISTANT_PATHS, COMPACT_MEDIA_QUERY, PHONE_MEDIA_QUERY, UI_LABELS } from "../../constants/Constants.js";
export { ASSISTANT_PATHS } from "../../constants/Constants.js";

export { ASSISTANT_NAME };

/** Reusable chat UI for createAiAssistant replies (React 18+); all text is rendered escaped. */

const DEFAULT_LABELS = UI_LABELS;
const SERIES_COLORS = ["var(--b2y-ai-accent, #4f46e5)", "#0f9d8a", "#e8590c", "#7048e8", "#d6336c", "#2b8a3e"];

const formatValue = (value) => (typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value === null || value === undefined ? "–" : String(value));
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const toViewMessages = (loaded) => (Array.isArray(loaded) ? loaded : []).filter((message) => message && (message.role === "user" || message.role === "assistant")).map((message) => ({ role: message.role, text: String(message.text ?? ""), blocks: Array.isArray(message.blocks) ? message.blocks : [] }));

const icon = (paths, size = 16) => h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" }, ...paths.map((d, index) => h("path", { key: index, d })));
/**
 * Beya's icon, the same in every application: a friendly line-style bot (outline in the text colour, teal
 * antenna, ears and signal). Parts are grouped so the launcher can animate them (tilt, blink, signal pulse).
 */
const BOT = Object.freeze({
  outline: ["M8.5 8.2h7a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3z", "M6.6 21.6a5.4 3.9 0 0 1 10.8 0z"],
  eyes: ["M10 11.4v1.6", "M14 11.4v1.6"],
  accent: ["M12 6.7v1.5", "M3.9 12.2h1.6", "M18.5 12.2h1.6"],
  signal: ["M9.3 3.7a3.8 3.8 0 0 1 5.4 0", "M10.9 5.3a1.6 1.6 0 0 1 2.2 0"],
});
const botPaths = (paths) => paths.map((d, index) => h("path", { key: index, d }));
const botIcon = (size) =>
  h(
    "svg",
    { className: "b2y-ai-bot", width: size, height: size, viewBox: "0 0 24 24", fill: "none", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" },
    h("g", { stroke: "currentColor" }, ...botPaths(BOT.outline)),
    h("g", { className: "b2y-ai-bot-eyes", stroke: "currentColor" }, ...botPaths(BOT.eyes)),
    h("g", { className: "b2y-ai-bot-accent" }, ...botPaths(BOT.accent)),
    h("g", { className: "b2y-ai-bot-signal" }, ...botPaths(BOT.signal)),
  );
const CLOSE = ["M18 6 6 18", "M6 6l12 12"];
const PANEL = ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18"];
const CHAT = ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"];
const USER = ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"];
const SEND = ["M5 12h14", "M13 6l6 6-6 6"];
const PLUS = ["M12 5v14", "M5 12h14"];
const CLOCK = ["M12 7v5l3 2", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"];
const ALERT = ["M12 9v4", "M12 17h.01", "M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"];

/** The assistant's picture: Beya's bot in every application unless one passes its own avatar. */
const Avatar = ({ avatar }) => h("span", { className: "b2y-ai-avatar", "aria-hidden": "true" }, avatar ?? botIcon(22));

/** Three animated dots while the assistant is working. */
export function TypingIndicator({ label = DEFAULT_LABELS.typing }) {
  return h("div", { className: "b2y-ai-typing", role: "status", "aria-label": label }, h("span", null), h("span", null), h("span", null));
}

function Chart({ spec }) {
  if (!spec || !Array.isArray(spec.xLabels) || !Array.isArray(spec.series) || spec.xLabels.length < 2) return null;
  const width = 560;
  const height = 200;
  const pad = { left: 44, right: 8, top: 18, bottom: 28 };
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
    h("text", { key: "half", x: pad.left - 6, y: pad.top + innerH / 2 + 4, textAnchor: "end", className: "b2y-ai-tick" }, formatValue(Math.round(max / 2))),
    ...spec.xLabels.map((label, index) => (index % every === 0 ? h("text", { key: `x${index}`, x: isLine ? x(index) : pad.left + ((index + 0.5) * innerW) / n, y: height - 8, textAnchor: "middle", className: "b2y-ai-tick" }, String(label).slice(0, 12)) : null)),
  ];
  spec.series.forEach((series, seriesIndex) => {
    const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
    if (isLine) {
      children.push(h("polyline", { key: `s${seriesIndex}`, fill: "none", stroke: color, strokeWidth: 2.25, strokeLinejoin: "round", strokeLinecap: "round", points: series.values.map((value, index) => `${x(index)},${y(value)}`).join(" ") }));
      if (n <= 24) series.values.forEach((value, index) => children.push(h("circle", { key: `p${seriesIndex}-${index}`, cx: x(index), cy: y(value), r: 3, fill: "#fff", stroke: color, strokeWidth: 2 })));
    } else {
      const slot = innerW / n;
      const barW = Math.max(2, (slot * 0.7) / spec.series.length);
      series.values.forEach((value, index) => {
        const barX = pad.left + index * slot + slot * 0.15 + seriesIndex * barW;
        children.push(h("rect", { key: `b${seriesIndex}-${index}`, x: barX, y: y(value), width: barW, height: Math.max(0, pad.top + innerH - y(value)), fill: color, rx: 4 }));
        // Values above the bars when there is room for them.
        if (spec.series.length === 1 && n <= 12) children.push(h("text", { key: `v${index}`, x: barX + barW / 2, y: y(value) - 5, textAnchor: "middle", className: "b2y-ai-value" }, formatValue(value)));
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

/** A flowchart as ordered steps; decisions list their branches. */
function Flow({ block }) {
  const labelOf = new Map(block.nodes.map((node) => [node.id, node.label]));
  return h(
    "figure",
    { className: "b2y-ai-card b2y-ai-flow" },
    block.title ? h("figcaption", { className: "b2y-ai-card-title" }, block.title) : null,
    h(
      "ol",
      null,
      ...block.nodes.map((node) => {
        const branches = block.edges.filter((edge) => edge.from === node.id && (node.kind === "decision" || edge.label));
        return h(
          "li",
          { key: node.id, className: `b2y-ai-flow-${node.kind}` },
          h("span", null, node.label),
          branches.length > 0 ? h("ul", null, ...branches.map((edge, index) => h("li", { key: index }, `${edge.label || "Next"} → ${labelOf.get(edge.to) ?? ""}`))) : null,
        );
      }),
    ),
  );
}

/** Item cards (products, listings). Links open through onOpenLink when given (in-app navigation). */
function Cards({ block, onOpenLink }) {
  return h(
    "div",
    { className: "b2y-ai-cards-block" },
    block.title ? h("p", { className: "b2y-ai-cards-title" }, block.title) : null,
    h(
      "div",
      { className: "b2y-ai-cards" },
      ...block.items.map((item, index) => {
        const body = [
          item.image ? h("div", { key: "img", className: "b2y-ai-item-image" }, h("img", { src: item.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer" })) : h("div", { key: "img", className: "b2y-ai-item-image b2y-ai-item-image-empty" }, item.title.slice(0, 1).toUpperCase()),
          item.badge ? h("span", { key: "badge", className: "b2y-ai-item-badge" }, item.badge) : null,
          h("span", { key: "title", className: "b2y-ai-item-title" }, item.title),
          item.subtitle ? h("span", { key: "sub", className: "b2y-ai-item-subtitle" }, item.subtitle) : null,
          item.price ? h("span", { key: "price", className: "b2y-ai-item-price" }, item.price, item.oldPrice ? h("s", null, item.oldPrice) : null) : null,
        ];
        if (!item.link) return h("div", { key: index, className: "b2y-ai-item" }, ...body);
        const external = item.link.startsWith("https://");
        return h(
          "a",
          {
            key: index,
            className: "b2y-ai-item",
            href: item.link,
            ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
            onClick: onOpenLink && !external ? (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onOpenLink(item.link); } : undefined,
          },
          ...body,
        );
      }),
    ),
  );
}

function Block({ block, labels, onOpenLink }) {
  switch (block.type) {
    case "heading":
      return h("h4", { className: "b2y-ai-heading" }, block.text);
    case "paragraph":
      return h("p", { className: "b2y-ai-paragraph" }, block.text);
    case "bullets":
      return h("ul", { className: "b2y-ai-bullets" }, ...block.items.map((item, index) => h("li", { key: index }, item)));
    case "metrics":
      return h("div", { className: "b2y-ai-metrics" }, ...block.items.map((item, index) => h("div", { key: index, className: "b2y-ai-metric" }, h("span", { className: "b2y-ai-metric-label" }, item.label), h("span", { className: "b2y-ai-metric-value" }, item.value))));
    case "table": {
      const numeric = block.columns.map((_, index) => block.rows.some((row) => typeof row[index] === "number"));
      return h(
        "div",
        { className: "b2y-ai-card b2y-ai-table-card" },
        h(
          "div",
          { className: "b2y-ai-table-wrap" },
          h("table", { className: "b2y-ai-table" }, h("thead", null, h("tr", null, ...block.columns.map((column, index) => h("th", { key: index, className: numeric[index] ? "b2y-ai-num" : undefined }, column)))), h("tbody", null, ...block.rows.map((row, rowIndex) => h("tr", { key: rowIndex }, ...row.map((cell, cellIndex) => h("td", { key: cellIndex, className: typeof cell === "number" ? "b2y-ai-num" : undefined }, formatValue(cell))))))),
        ),
        block.truncated ? h("p", { className: "b2y-ai-muted" }, labels.truncated) : null,
      );
    }
    case "chart":
      return h(Chart, { spec: block.spec });
    case "notice":
      return h("div", { className: `b2y-ai-notice b2y-ai-notice-${block.tone}` }, block.title ? h("strong", null, block.title) : null, h("ul", null, ...block.items.map((item, index) => h("li", { key: index }, item))));
    case "flow":
      return h(Flow, { block });
    case "cards":
      return h(Cards, { block, onOpenLink });
    case "sources":
      return h("div", { className: "b2y-ai-sources" }, h("span", null, `${labels.sources}:`), ...block.items.map((item, index) => (item.url ? h("a", { key: index, href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title) : h("span", { key: index }, item.title))));
    default:
      return null;
  }
}

/** One assistant reply rendered from its blocks. */
export function AssistantMessage({ blocks = [], labels: labelOverrides = {}, onOpenLink }) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  return h("div", { className: "b2y-ai-answer" }, ...blocks.map((block, index) => h(Block, { key: index, block, labels, onOpenLink })));
}

/**
 * The conversation to open: the given id, none for null, otherwise the latest; empty starts fresh.
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
 * conversationId: an id opens it, null starts a new chat, undefined reopens the latest (listConversations).
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
export function AssistantChat({ send, loadConversation, listConversations, conversationId: initialConversationId, onConversationChange, title, intro, suggestions = [], labels: labelOverrides = {}, maxLength = 4000, className = "", style, onOpenLink, avatar, variant = "panel" }) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const page = variant === "page";
  const [sidebarOpen, setSidebarOpen] = useState(() => !globalThis.matchMedia?.(PHONE_MEDIA_QUERY).matches);
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
  // Synchronous guard against double submits.
  const inFlight = useRef(false);
  const callbacks = useRef({ loadConversation, listConversations, onConversationChange });
  callbacks.current = { loadConversation, listConversations, onConversationChange };

  /** Opens a conversation; an empty result starts fresh. */
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

  // The chat list follows the screen: open on wider screens, a closed drawer on phones.
  useEffect(() => {
    const query = page ? globalThis.matchMedia?.(PHONE_MEDIA_QUERY) : null;
    if (!query?.addEventListener) return undefined;
    const sync = () => setSidebarOpen(!query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [page]);

  useEffect(() => {
    if (!page || recent !== null || restoring || !callbacks.current.listConversations) return undefined;
    let active = true;
    callbacks.current
      .listConversations()
      .then((rows) => active && setRecent(Array.isArray(rows) ? rows : []))
      .catch(() => active && setRecent([]));
    return () => {
      active = false;
    };
  }, [page, recent, restoring]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages, sending, error]);

  const ask = useCallback(
    async (text, { retry = false } = {}) => {
      const message = String(text ?? "").trim();
      if (!message || message.length > maxLength || sending || restoring || inFlight.current) return;
      inFlight.current = true;
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
        inFlight.current = false;
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
    h("div", { className: "b2y-ai-title" }, h(Avatar, { avatar }), h("div", null, h("strong", null, title ?? labels.title), h("span", null, labels.subtitle))),
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

  const messageList = h(
      "div",
      { className: "b2y-ai-messages", ref: scrollRef, "aria-live": "polite", "aria-busy": sending || restoring },
      restoring ? h("div", { className: "b2y-ai-restoring" }, h(TypingIndicator, { label: labels.loading }), h("span", null, labels.loading)) : null,
      empty
        ? h(
            "div",
            { className: "b2y-ai-empty" },
            h("span", { className: "b2y-ai-empty-icon", "aria-hidden": "true" }, avatar ?? botIcon(34)),
            h("h3", { className: "b2y-ai-greeting" }, labels.greeting),
            intro ? h("p", { className: "b2y-ai-intro" }, intro) : null,
            suggestions.length > 0 ? h("div", { className: "b2y-ai-suggestions" }, ...suggestions.map((suggestion) => h("button", { key: suggestion, type: "button", onClick: () => ask(suggestion) }, suggestion))) : null,
          )
        : null,
      ...messages.map((message, index) =>
        message.role === "user"
          ? h("div", { key: index, className: "b2y-ai-row b2y-ai-row-user" }, h("p", { className: "b2y-ai-bubble-user" }, message.text), page ? h("span", { className: "b2y-ai-user-avatar", "aria-hidden": "true" }, icon(USER, 16)) : null)
          : h("div", { key: index, className: "b2y-ai-row b2y-ai-row-assistant" }, h(Avatar, { avatar }), h("div", { className: "b2y-ai-bubble" }, h(AssistantMessage, { labels, onOpenLink, blocks: message.blocks?.length ? message.blocks : message.text ? [{ type: "paragraph", text: message.text }] : [] }))),
      ),
      sending ? h("div", { className: "b2y-ai-row b2y-ai-row-assistant" }, h(Avatar, { avatar }), h(TypingIndicator, { label: labels.typing })) : null,
      error
        ? h("div", { className: "b2y-ai-error", role: "alert" }, icon(ALERT, 16), h("span", null, error.message), h("button", { type: "button", onClick: () => ask(error.retryText, { retry: true }), disabled: sending }, labels.retry))
        : null,
    );
  const composer = h(
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
    );

  if (!page) return h("div", { className: `b2y-ai-chat ${className}`.trim(), style }, header, messageList, composer);

  // Page layout: conversations sidebar (a drawer on phones), a title bar, the conversation and the composer.
  const closeOnPhone = () => globalThis.matchMedia?.(PHONE_MEDIA_QUERY).matches && setSidebarOpen(false);
  const currentTitle = (recent ?? []).find((row) => row.conversationId === conversationId)?.title || (messages.find((message) => message.role === "user")?.text ?? "").slice(0, 80) || title || labels.title;
  const sidebar = h(
    "aside",
    { className: "b2y-ai-sidebar", "aria-label": labels.history },
    h("button", { type: "button", className: "b2y-ai-new-chat", onClick: () => (newChat(), closeOnPhone()), disabled: sending }, icon(PLUS, 16), h("span", null, labels.newChat)),
    listConversations && loadConversation ? h("p", { className: "b2y-ai-sidebar-label" }, labels.recent) : null,
    listConversations && loadConversation
      ? h(
          "nav",
          { className: "b2y-ai-conversations" },
          recent === null ? h(TypingIndicator, { label: labels.loading }) : recent.length === 0 ? h("p", { className: "b2y-ai-muted" }, labels.noHistory) : null,
          ...(recent ?? []).map((row) =>
            h(
              "button",
              { key: row.conversationId, type: "button", title: row.title || labels.untitled, "aria-current": row.conversationId === conversationId ? "true" : undefined, className: row.conversationId === conversationId ? "b2y-ai-conversation b2y-ai-active" : "b2y-ai-conversation", onClick: () => (open(row.conversationId), closeOnPhone()), disabled: sending },
              icon(CHAT, 15),
              h("span", null, row.title || labels.untitled),
            ),
          ),
        )
      : null,
  );
  return h(
    "div",
    { className: `b2y-ai-chat b2y-ai-page${sidebarOpen ? " b2y-ai-sidebar-open" : ""} ${className}`.trim(), style },
    sidebar,
    sidebarOpen ? h("div", { className: "b2y-ai-scrim", "aria-hidden": "true", onClick: () => setSidebarOpen(false) }) : null,
    h(
      "section",
      { className: "b2y-ai-main" },
      h(
        "div",
        { className: "b2y-ai-page-header" },
        h("button", { type: "button", className: "b2y-ai-icon-button", onClick: () => setSidebarOpen((value) => !value), "aria-label": labels.toggleSidebar, "aria-expanded": sidebarOpen, title: labels.toggleSidebar }, icon(PANEL, 18)),
        h("span", { className: "b2y-ai-page-mark", "aria-hidden": "true" }, avatar ?? botIcon(20)),
        h("strong", { className: "b2y-ai-page-title" }, currentTitle),
      ),
      messageList,
      composer,
    ),
  );
}

/**
 * A client for the application's assistant API, in the B2Y response shape { status, message, data }.
 * headers() returns the application's own headers (sign-in token, tenant domain) for each request.
 * @param {{ baseUrl: string, headers?: () => Record<string, string>, paths?: Partial<typeof ASSISTANT_PATHS>, fetch?: typeof fetch, fallbackError?: string }} options
 */
export function createAssistantClient({ baseUrl, headers = () => ({}), paths = {}, fetch: fetchImpl = globalThis.fetch, fallbackError = DEFAULT_LABELS.error }) {
  const route = { ...ASSISTANT_PATHS, ...paths };
  const call = async (path, init = {}) => {
    let response;
    let body;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", ...headers(), ...(init.headers ?? {}) } });
      body = await response.json().catch(() => null);
    } catch {
      throw Object.assign(new Error("Assistant request failed"), { userMessage: fallbackError });
    }
    if (!response.ok || body?.status !== "SUCCESS") throw Object.assign(new Error("Assistant request failed"), { userMessage: body?.message || fallbackError, status: response.status });
    return body.data;
  };
  return Object.freeze({
    isEnabled: () => call(route.status).then((data) => data?.enabled === true).catch(() => false),
    send: ({ message, conversationId }) => call(route.chat, { method: "POST", body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }) }),
    listConversations: () => call(route.conversations).then((data) => data?.conversations ?? []),
    loadConversation: (id) => call(`${route.conversations}/${encodeURIComponent(id)}`).then((data) => data?.messages ?? []),
  });
}

/**
 * The assistant as a floating button and chat panel (bottom right), shown only when the server says the
 * assistant is available to this user. Same look in every application; theme it with --b2y-ai-* variables.
 * With onLaunch, the button opens the application's own assistant page instead of the panel (consoles that
 * have a full-page assistant); pass hidden on that page itself.
 * @param {{ client: ReturnType<typeof createAssistantClient>, onLaunch?: () => void, hidden?: boolean, launcherLabel?: string, closeLabel?: string, avatar?: unknown,
 *   title?: string, intro?: string, suggestions?: string[], labels?: object, onOpenLink?: (link: string) => void, className?: string, style?: object }} props
 */
export function AssistantWidget({ client, onLaunch, hidden = false, launcherLabel = UI_LABELS.launcher, closeLabel = UI_LABELS.close, avatar, className = "", style, onOpenLink, ...chat }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    client.isEnabled().then((value) => active && setEnabled(value));
    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [open]);
  if (!enabled || hidden) return null;
  if (onLaunch) {
    return h(
      "div",
      { className: `b2y-ai-widget ${className}`.trim(), style },
      h(
        "button",
        { type: "button", className: "b2y-ai-launcher", "aria-label": launcherLabel, onClick: onLaunch },
        h("span", { className: "b2y-ai-launcher-icon" }, avatar ?? botIcon(28), h("span", { className: "b2y-ai-launcher-dot", "aria-hidden": "true" })),
        h("span", { className: "b2y-ai-launcher-text" }, launcherLabel),
      ),
    );
  }
  const openLink = onOpenLink
    ? (link) => {
        onOpenLink(link);
        if (globalThis.matchMedia?.(COMPACT_MEDIA_QUERY).matches) setOpen(false);
      }
    : undefined;
  return h(
    "div",
    { className: `b2y-ai-widget ${className}`.trim(), style },
    open
      ? h(
          "div",
          { className: "b2y-ai-widget-panel", role: "dialog", "aria-label": chat.title ?? ASSISTANT_NAME },
          h("button", { type: "button", className: "b2y-ai-widget-close", "aria-label": closeLabel, onClick: () => setOpen(false) }, icon(CLOSE, 18)),
          h(AssistantChat, { ...chat, avatar, onOpenLink: openLink, send: client.send, loadConversation: client.loadConversation, listConversations: client.listConversations }),
        )
      : null,
    h(
      "button",
      { type: "button", className: `b2y-ai-launcher${open ? " b2y-ai-launcher-open" : ""}`, "aria-expanded": open, "aria-label": open ? closeLabel : launcherLabel, onClick: () => setOpen((value) => !value) },
      open ? icon(CLOSE, 22) : h("span", { className: "b2y-ai-launcher-icon" }, avatar ?? botIcon(28), h("span", { className: "b2y-ai-launcher-dot", "aria-hidden": "true" })),
      open ? null : h("span", { className: "b2y-ai-launcher-text" }, launcherLabel),
    ),
  );
}
