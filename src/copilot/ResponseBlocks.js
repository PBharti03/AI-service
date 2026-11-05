import { z } from "zod";
import { chartSpecSchema } from "../analytics/ResultChart.js";

/**
 * The response format every assistant reply uses: a short list of blocks a UI can render without
 * knowing where they came from. Blocks never contain SQL, tool names, internal ids or raw JSON.
 */

const text = (max) => z.string().trim().min(1).max(max);
const cell = z.union([z.string().max(200), z.number().finite(), z.null()]);

export const responseBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("heading"), text: text(120) }),
  z.strictObject({ type: z.literal("paragraph"), text: text(2000) }),
  z.strictObject({ type: z.literal("bullets"), items: z.array(text(400)).min(1).max(12) }),
  z.strictObject({ type: z.literal("metrics"), items: z.array(z.strictObject({ label: text(60), value: text(40) })).min(1).max(8) }),
  z.strictObject({
    type: z.literal("table"),
    title: text(120).optional(),
    columns: z.array(text(60)).min(1).max(8),
    rows: z.array(z.array(cell).max(8)).max(50),
    truncated: z.boolean(),
  }),
  z.strictObject({ type: z.literal("chart"), spec: chartSpecSchema }),
  z.strictObject({ type: z.literal("notice"), tone: z.enum(["info", "warning"]), title: text(80).optional(), items: z.array(text(300)).min(1).max(8) }),
  z.strictObject({ type: z.literal("sources"), items: z.array(z.strictObject({ title: text(160), url: z.url().max(500).optional() })).min(1).max(8) }),
]);

export const responseBlocksSchema = z.array(responseBlockSchema).max(30);

const MAX_TABLE_ROWS = 50;

/** "order_value" -> "Order value"; labels win when the application supplied one. */
function columnLabel(name, labels) {
  if (Object.hasOwn(labels, name)) return labels[name];
  const words = String(name).replace(/_/g, " ").trim();
  return words.length === 0 ? String(name) : words[0].toUpperCase() + words.slice(1);
}

const formatCell = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(value)) return value.slice(0, 10);
  return String(value).slice(0, 200);
};

/**
 * Blocks for an analytics report (see createAnalyticsAssistant): the findings first, then per section a
 * metric row (single-row results), a chart when useful, and a table; notes and unanswered parts last.
 * The planner's own explanation and the SQL are never included.
 * @param {object} report
 * @param {{ labels?: Record<string, string>, locale?: string }} [options]
 */
export function analyticsReportToBlocks(report, { labels = {}, locale = "en-US" } = {}) {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const blocks = [];
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const headline = sections.flatMap((section) => section.observations.slice(0, 1).map((observation) => observation.text)).slice(0, 3);
  if (headline.length > 0) blocks.push({ type: "paragraph", text: headline.join(" ").slice(0, 2000) });
  for (const section of sections) {
    if (sections.length > 1) blocks.push({ type: "heading", text: String(section.title).slice(0, 120) });
    const names = section.columns.map((column) => column.name);
    const singleNumbers = section.rows.length === 1 && section.rows[0].every((value) => typeof formatCell(value) === "number");
    if (singleNumbers) {
      blocks.push({ type: "metrics", items: names.slice(0, 8).map((name, index) => ({ label: columnLabel(name, labels).slice(0, 60), value: format.format(formatCell(section.rows[0][index])) })) });
    } else {
      if (section.chart && section.rows.length >= 2) blocks.push({ type: "chart", spec: section.chart });
      blocks.push({
        type: "table",
        columns: names.slice(0, 8).map((name) => columnLabel(name, labels).slice(0, 60)),
        rows: section.rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, 8).map((value) => formatCell(value))),
        truncated: section.truncated === true || section.rows.length > MAX_TABLE_ROWS,
      });
    }
    const more = section.observations.slice(1, 5).map((observation) => observation.text);
    if (more.length > 0) blocks.push({ type: "bullets", items: more });
  }
  const notes = (report.notes ?? []).map((note) => note.text);
  if (notes.length > 0) blocks.push({ type: "notice", tone: "info", items: notes.slice(0, 8) });
  const missing = [
    ...(report.unanswered ?? []).map((item) => `${item.part}: ${item.reason}`),
    ...(report.failures ?? []).map((item) => item.reason),
  ];
  if (missing.length > 0) blocks.push({ type: "notice", tone: "warning", title: "Not answered", items: [...new Set(missing)].slice(0, 8).map((item) => item.slice(0, 300)) });
  return responseBlocksSchema.parse(blocks.slice(0, 30));
}
