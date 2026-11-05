import { z } from "zod";

/**
 * Turns a checked query result into a chart specification the UI can draw: when the shape fits (one label
 * column followed by 1-6 numeric columns), otherwise null and the caller shows a table. Built in code from
 * the result; no value is ever sent to a model.
 */

const MAX_POINTS = 36;
const MAX_SERIES = 6;
const MAX_PIE_SLICES = 8;
/** Every chart type a spec may name. The UI can switch between the compatible ones without a new query. */
export const CHART_TYPES = ["bar", "horizontal_bar", "stacked_bar", "line", "area", "pie", "doughnut"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/;

export const chartSpecSchema = z
  .strictObject({
    chartType: z.enum(CHART_TYPES),
    /** Types that suit this data, including chartType; the UI offers them as a switch. */
    alternatives: z.array(z.enum(CHART_TYPES)).min(1).max(CHART_TYPES.length),
    /** "table" when the user asked for tabular data; the chart is one click away. */
    initialView: z.enum(["chart", "table"]),
    title: z.string().min(1).max(120),
    xLabels: z.array(z.string().min(1).max(40)).min(1).max(MAX_POINTS),
    series: z
      .array(z.strictObject({ name: z.string().min(1).max(60), values: z.array(z.number().finite().min(0)).min(1).max(MAX_POINTS) }))
      .min(1)
      .max(MAX_SERIES),
    /** Which validated statements the numbers come from (sha256 fingerprints, never the SQL or values). */
    basis: z.strictObject({
      kind: z.literal("sql"),
      fingerprints: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(4),
      generatedAt: z.iso.datetime(),
    }),
  })
  .superRefine((chart, ctx) => {
    chart.series.forEach((series, index) => {
      if (series.values.length !== chart.xLabels.length) ctx.addIssue({ code: "custom", path: ["series", index], message: "values must match xLabels" });
    });
    if ((chart.chartType === "doughnut" || chart.chartType === "pie") && chart.series.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["series"], message: "one series" });
    }
    if (!chart.alternatives.includes(chart.chartType)) ctx.addIssue({ code: "custom", path: ["alternatives"], message: "must include chartType" });
  });

/** A cell as a number: numbers and numeric strings (PostgreSQL returns bigint and numeric as text). Null counts as 0. */
export function numericCell(cell) {
  if (cell === null) return 0;
  const value = typeof cell === "number" ? cell : typeof cell === "string" && /^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Whether every cell is an ISO date (YYYY-MM-DD, optionally with a time). */
export function isDateColumn(cells) {
  return cells.length > 0 && cells.every((cell) => typeof cell === "string" && ISO_DAY.test(cell));
}

/** Dates as "Jan 2026" when every label is the 1st of a month, otherwise "2 Jan 2026"; other text as is. */
export function formatLabels(cells, valueLabels = {}) {
  if (isDateColumn(cells)) {
    const days = cells.map((cell) => ISO_DAY.exec(cell));
    const monthly = days.every((match) => match[3] === "01");
    return { dates: true, labels: days.map(([, year, month, day]) => `${monthly ? "" : `${Number(day)} `}${MONTHS[Number(month) - 1]} ${year}`) };
  }
  return {
    dates: false,
    labels: cells.map((cell) => {
      if (cell === null) return "(none)";
      const text = String(cell);
      return (Object.hasOwn(valueLabels, text) ? valueLabels[text] : text).slice(0, 40) || "(empty)";
    }),
  };
}

/**
 * "Long" results (label, category, number), such as month / platform / count, become one row per label
 * with a column per category (at most MAX_SERIES categories; missing combinations count as 0).
 */
function pivotLong(result) {
  const { columns, rows } = result;
  if (columns.length !== 3 || rows.length === 0) return result;
  // The middle column must be a text category (not a number PostgreSQL returned as text).
  if (!rows.every((row) => typeof row[1] === "string" && numericCell(row[1]) === undefined && numericCell(row[2]) !== undefined)) return result;
  const categories = [...new Set(rows.map((row) => row[1]))];
  if (categories.length < 2 || categories.length > MAX_SERIES) return result;
  const byLabel = new Map();
  for (const [label, category, value] of rows) {
    const key = String(label);
    if (!byLabel.has(key)) byLabel.set(key, { label, values: new Map() });
    byLabel.get(key).values.set(category, numericCell(value));
  }
  return {
    columns: [columns[0], ...categories.map((name) => ({ name }))],
    rows: [...byLabel.values()].map(({ label, values }) => [label, ...categories.map((category) => values.get(category) ?? 0)]),
  };
}

/** One row of several numbers (for example count(*) FILTER per category) becomes one bar per column. */
function transposeSingleRow(result) {
  const { columns, rows } = result;
  if (rows.length !== 1 || columns.length < 2 || !rows[0].every((cell) => numericCell(cell) !== undefined)) return result;
  return { columns: [{ name: "measure" }, { name: "value" }], rows: columns.map((column, index) => [column.name, numericCell(rows[0][index])]) };
}

/** Chart types that can show this data: pies need one series of at most 8 values, lines at least 2 points. */
function compatibleTypes(points, series) {
  const types = ["bar", "horizontal_bar"];
  if (series.length >= 2) types.push("stacked_bar");
  if (points >= 2) types.push("line", "area");
  if (series.length === 1 && points >= 2 && points <= MAX_PIE_SLICES && series[0].values.some((value) => value > 0)) types.push("pie", "doughnut");
  return types;
}

/** Without a requested type: lines for dates, horizontal bars for many or long labels, otherwise bars. */
function defaultType(x, alternatives) {
  if (x.dates && alternatives.includes("line")) return "line";
  if (x.labels.length > 12 || x.labels.some((label) => label.length > 14)) return "horizontal_bar";
  return "bar";
}

/**
 * A chart when the shape fits, or null. The hint picks the type when it suits the data, but a hint of
 * "table" or "none" does not hide a chartable result; a single number is never charted.
 * @param {{ columns: readonly { name: string }[], rows: readonly (readonly unknown[])[] }} result
 * @param {{ chartHint?: string, title?: string, fingerprints: readonly string[], generatedAt?: string, labels?: Record<string, string>, valueLabels?: Record<string, string> }} options
 */
export function buildResultChart(result, { chartHint, title, fingerprints, generatedAt = new Date().toISOString(), labels = {}, valueLabels = {} }) {
  const { columns, rows } = transposeSingleRow(pivotLong(result));
  if (rows.length === 0 || rows.length > MAX_POINTS || (rows.length === 1 && columns.length < 2)) return null;
  if (columns.length < 2 || columns.length - 1 > MAX_SERIES) return null;
  const series = [];
  for (let index = 1; index < columns.length; index += 1) {
    const values = rows.map((row) => numericCell(row[index]));
    if (values.some((value) => value === undefined || value < 0)) return null;
    const name = columns[index].name;
    series.push({ name: (labels[name] ?? valueLabels[name] ?? name).slice(0, 60), values });
  }
  const x = formatLabels(
    rows.map((row) => row[0]),
    valueLabels,
  );
  const alternatives = compatibleTypes(x.labels.length, series);
  const chartType = alternatives.includes(chartHint) ? chartHint : defaultType(x, alternatives);
  const parsed = chartSpecSchema.safeParse({
    chartType,
    alternatives,
    initialView: chartHint === "table" ? "table" : "chart",
    title: (title || "Statistics").slice(0, 120),
    xLabels: x.labels,
    series,
    basis: { kind: "sql", fingerprints: [...fingerprints], generatedAt },
  });
  return parsed.success ? parsed.data : null;
}
