import { ASSISTANT_NAME } from "./AssistantConstants.js";

/** Keep in sync with the breakpoints in styles.css. */
export const PHONE_MEDIA_QUERY = "(max-width: 767px)";
export const COMPACT_MEDIA_QUERY = "(max-width: 640px)";

/** Default UI text; applications pass translated labels to override any of them. */
export const UI_LABELS = Object.freeze({
  title: ASSISTANT_NAME,
  greeting: "How can I help you today?",
  subtitle: "Ask anything: questions about your data, advice or general topics.",
  placeholder: "Ask a question",
  send: "Send",
  retry: "Try again",
  newChat: "New chat",
  history: "Recent chats",
  noHistory: "No recent chats",
  loading: "Loading your conversation",
  error: "The assistant could not answer. Please try again.",
  typing: `${ASSISTANT_NAME} is typing`,
  hint: "Enter to send, Shift + Enter for a new line",
  untitled: "Conversation",
  truncated: "Showing the first rows.",
  sources: "Sources",
  recent: "Recent",
  toggleSidebar: "Show or hide chats",
  launcher: `Ask ${ASSISTANT_NAME}`,
  close: "Close",
});
