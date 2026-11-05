import { formatLabels, isDateColumn, numericCell } from "./ResultChart.js";

/**
 * Combines and describes checked query results in code. Nothing here calls a model: every observation is
 * computed from the result cells and carries the values it is based on (evidence), so the UI can show why
 * a statement was made.
 */

/**
 * @typedef {Object} AnalyticsSection
 * @property {string} id - "q1" or, for merged results, "q1+q2".
 * @property {string} title
 * @property {readonly string[]} queryIds - The planned queries the numbers come from.
 * @property {readonly { name: string }[]} columns
 * @property {readonly (readonly (string | number | boolean | null)[])[]} rows
 * @property {boolean} truncated
 */

/**
 * @typedef {Object} Evidence
 * @property {readonly string[]} queryIds
 * @property {string | null} label - The row label (category or period) the value belongs to, if any.
 * @property {string} column
 * @property {number} value
 */

/** @typedef {{ text: string, evidence: readonly Evidence[] }} Observation */

/** Which columns are numbers, and what kind of label column the section has (first column only). */
export function describeShape(section) {
  const { columns, rows } = section;
  const column = (index) => rows.map((row) => row[index]);
  const numeric = (index) => rows.length > 0 && column(index).every((cell) => cell !== null && numericCell(cell) !== undefined);
  const first = rows.length === 0 ? "none" : isDateColumn(column(0)) ? "date" : numeric(0) ? "number" : "category";
  if (first === "number") return { label: "none", metrics: columns.map((_, index) => index) };
  const metrics = [];
  for (let index = 1; index < columns.length; index += 1) {
    // Merged results may have gaps (null): a column with numbers and gaps still counts as a metric.
    const cells = column(index);
    if (cells.some((cell) => cell !== null) && cells.every((cell) => cell === null || numericCell(cell) !== undefined)) metrics.push(index);
  }
  return { label: first, metrics };
}

const isoKey = (cell) => (typeof cell === "string" ? cell.slice(0, 10) : String(cell));

/**
 * Lines up independent results that share a mergeKey: each must have that key as its first column and
 * only numbers after it. Rows are matched on the key; a key missing from one result leaves null there.
 * Results that cannot be lined up stay separate. Never touches SQL: merging happens after execution.
 * @param {readonly (AnalyticsSection & { mergeKey: string })[]} sections - In plan order.
 * @returns {AnalyticsSection[]}
 */
export function mergeSections(sections) {
  const groups = new Map();
  for (const section of sections) {
    const key = section.mergeKey;
    const mergeable =
      key !== "" &&
      section.columns.length >= 2 &&
      section.columns[0].name === key &&
      describeShape(section).metrics.length === section.columns.length - 1 &&
      section.rows.length > 0;
    if (!mergeable) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(section);
  }

  const merged = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const dates = members.every((member) => isDateColumn(member.rows.map((row) => row[0])));
    const order = [];
    const seen = new Set();
    for (const member of members) {
      for (const row of member.rows) {
        const id = dates ? isoKey(row[0]) : String(row[0]);
        if (!seen.has(id)) {
          seen.add(id);
          order.push({ id, label: dates ? isoKey(row[0]) : row[0] });
        }
      }
    }
    if (dates) order.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const names = new Set([key]);
    const columns = [{ name: key }];
    const lookups = [];
    for (const member of members) {
      const byKey = new Map(member.rows.map((row) => [dates ? isoKey(row[0]) : String(row[0]), row]));
      for (let index = 1; index < member.columns.length; index += 1) {
        let name = member.columns[index].name;
        if (names.has(name)) name = `${name}_${member.id}`;
        names.add(name);
        columns.push({ name });
        lookups.push({ byKey, index });
      }
    }
    if (columns.length > 9) continue;
    const rows = order.map(({ id, label }) => [label, ...lookups.map(({ byKey, index }) => (byKey.has(id) ? byKey.get(id)[index] : null))]);
    merged.set(members[0].id, {
      id: members.map((member) => member.id).join("+"),
      title: members.map((member) => member.title).join(" and "),
      queryIds: members.flatMap((member) => member.queryIds),
      columns,
      rows,
      truncated: members.some((member) => member.truncated),
      members,
    });
  }

  const absorbed = new Set([...merged.values()].flatMap((section) => section.members.map((member) => member.id)));
  const out = [];
  for (const section of sections) {
    if (merged.has(section.id)) {
      const combined = { ...merged.get(section.id) };
      delete combined.members;
      out.push(combined);
    } else if (!absorbed.has(section.id)) {
      const plain = { ...section };
      delete plain.mergeKey;
      out.push(plain);
    }
  }
  return out;
}

function humanize(name, labels) {
  if (Object.hasOwn(labels, name)) return labels[name];
  const words = name.replace(/_/g, " ").trim();
  return words.length === 0 ? name : words[0].toUpperCase() + words.slice(1);
}

/**
 * Evidence-backed observations for one section: totals, the largest and smallest categories with their
 * share, peaks and the latest change over time, gaps, truncation and small-number caution.
 * @param {AnalyticsSection} section
 * @param {{ labels?: Record<string, string>, valueLabels?: Record<string, string>, locale?: string, today?: string, smallSampleBelow?: number }} [options]
 * @returns {Observation[]}
 */
export function observeSection(section, options = {}) {
  const { labels = {}, valueLabels = {}, locale = "en-US", today, smallSampleBelow = 30 } = options;
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const n = (value) => format.format(value);
  const { columns, rows, queryIds } = section;
  const shape = describeShape(section);
  const out = [];
  const evidence = (label, index, value) => ({ queryIds, label, column: columns[index].name, value });

  if (rows.length === 0) return [{ text: `${section.title}: no matching data.`, evidence: [] }];

  if (shape.label === "none") {
    // One row of numbers: report each.
    if (rows.length === 1) {
      const parts = shape.metrics.map((index) => ({ index, value: numericCell(rows[0][index]) }));
      out.push({
        text: `${parts.map(({ index, value }) => `${humanize(columns[index].name, labels)}: ${n(value)}`).join("; ")}.`,
        evidence: parts.map(({ index, value }) => evidence(null, index, value)),
      });
    }
    return out;
  }

  const rawLabels = rows.map((row) => row[0]);
  const shown = formatLabels(rawLabels, valueLabels).labels;
  const rowKey = (row) => (shape.label === "date" ? isoKey(row[0]) : String(row[0]));

  for (const index of shape.metrics) {
    const metric = humanize(columns[index].name, labels);
    const present = rows.map((row, at) => ({ at, value: row[index] === null ? null : numericCell(row[index]) }));
    const values = present.filter((item) => item.value !== null);
    if (values.length === 0) continue;
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const metricLower = metric.toLowerCase();

    if (shape.label === "category") {
      out.push({
        text: `${metric}: ${n(total)} in total across ${values.length} ${values.length === 1 ? "group" : "groups"}.`,
        evidence: values.map(({ at, value }) => evidence(rowKey(rows[at]), index, value)),
      });
      if (values.length >= 2 && total > 0) {
        const sorted = [...values].sort((a, b) => b.value - a.value);
        const top = sorted[0];
        const tied = sorted.filter((item) => item.value === top.value);
        if (tied.length === 1) {
          out.push({
            text: `${shown[top.at]} has the most ${metricLower}: ${n(top.value)} (${Math.round((top.value / total) * 100)}% of ${n(total)}).`,
            evidence: [evidence(rowKey(rows[top.at]), index, top.value)],
          });
        }
        const low = sorted[sorted.length - 1];
        if (values.length >= 3 && sorted.filter((item) => item.value === low.value).length === 1) {
          out.push({ text: `${shown[low.at]} has the fewest: ${n(low.value)}.`, evidence: [evidence(rowKey(rows[low.at]), index, low.value)] });
        }
      }
    } else {
      // The range covers the periods that have a value: in merged results another metric may start earlier.
      const first = shown[values[0].at];
      const last = shown[values[values.length - 1].at];
      out.push({
        text: `${metric}: ${n(total)} in total ${first === last ? `in ${first}` : `from ${first} to ${last}`}.`,
        evidence: values.map(({ at, value }) => evidence(rowKey(rows[at]), index, value)),
      });
      if (values.length >= 2) {
        const peak = values.reduce((best, item) => (item.value > best.value ? item : best));
        if (values.filter((item) => item.value === peak.value).length === 1) {
          out.push({ text: `${metric} peaked in ${shown[peak.at]} (${n(peak.value)}).`, evidence: [evidence(rowKey(rows[peak.at]), index, peak.value)] });
        }
        const latest = values[values.length - 1];
        const previous = values[values.length - 2];
        const change =
          previous.value === 0 ? "" : ` (${latest.value >= previous.value ? "+" : ""}${Math.round(((latest.value - previous.value) / previous.value) * 100)}%)`;
        const inProgress = today !== undefined && periodContains(rowKey(rows[latest.at]), rows, today);
        out.push({
          text: `${metric}: ${n(latest.value)} in ${shown[latest.at]} compared with ${n(previous.value)} in ${shown[previous.at]}${change}${inProgress ? `; ${shown[latest.at]} is not over yet` : ""}.`,
          evidence: [evidence(rowKey(rows[previous.at]), index, previous.value), evidence(rowKey(rows[latest.at]), index, latest.value)],
        });
      }
      const gaps = present.filter((item) => item.value === null);
      if (gaps.length > 0) {
        out.push({ text: `No ${metricLower} recorded in ${gaps.map((item) => shown[item.at]).join(", ")}.`, evidence: [] });
      }
    }

    if (Number.isInteger(total) && total > 0 && total < smallSampleBelow && index === shape.metrics[0]) {
      out.push({
        text: `These are small numbers (${n(total)} in total), so shares and changes can swing a lot.`,
        evidence: [{ queryIds, label: null, column: columns[index].name, value: total }],
      });
    }
  }
  if (section.truncated) out.push({ text: `${section.title}: only the first ${n(rows.length)} rows were returned; totals cover those rows only.`, evidence: [] });
  return out;
}

/**
 * Whether today falls in the latest period. The period length comes from the labels: years (all on
 * 1 January), months (all on the 1st), otherwise the spacing of the last two labels (a week, a day ...).
 */
function periodContains(latestKey, rows, today) {
  const keys = rows.map((row) => (typeof row[0] === "string" ? row[0].slice(0, 10) : ""));
  if (keys.every((key) => key.slice(5) === "01-01")) return today.slice(0, 4) === latestKey.slice(0, 4);
  if (keys.every((key) => key.slice(8) === "01")) return today.slice(0, 7) === latestKey.slice(0, 7);
  const day = (key) => Date.parse(`${key}T00:00:00Z`);
  const spacing = keys.length >= 2 ? day(keys[keys.length - 1]) - day(keys[keys.length - 2]) : 86_400_000;
  const start = day(latestKey);
  return day(today) >= start && day(today) < start + Math.max(spacing, 86_400_000);
}
