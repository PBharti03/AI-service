/**
 * Small, type-safe accessors over the JSON parse tree from libpg-query. Every node is an object with a single key naming its type ({ "SelectStmt": { ... } }); lists are plain arrays.
 * @typedef {Readonly<Record<string, unknown>>} Json
 */

/**
 * Small, type-safe accessors over the JSON parse tree from libpg-query. Every node is an object with a
 * single key naming its type ({ "SelectStmt": { ... } }); lists are plain arrays.
 */

export function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** [type, body] of a wrapped node, or undefined when the value is not a single-key node. */
export function nodeOf(value) {
  const object = asObject(value);
  if (object === undefined) return undefined;
  const keys = Object.keys(object);
  if (keys.length !== 1) return undefined;
  const type = keys[0] ?? "";
  const body = asObject(object[type]);
  return body === undefined ? undefined : [type, body];
}

export function asString(value) {
  return typeof value === "string" ? value : undefined;
}

/** The sval strings of a list of { String: { sval } } nodes, or undefined if any entry is something else. */
export function stringList(value) {
  const out = [];
  for (const item of asArray(value)) {
    const node = nodeOf(item);
    if (node?.[0] !== "String") return undefined;
    const text = asString(node[1].sval);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

export function locationOf(body) {
  const location = body.location;
  return typeof location === "number" && location >= 0 ? location : undefined;
}

/** Integer value of an A_Const node (ival; libpg-query omits 0 as {}), or undefined for other constants. */
export function integerConst(value) {
  const node = nodeOf(value);
  if (node?.[0] !== "A_Const") return undefined;
  const ival = asObject(node[1].ival);
  if (ival === undefined) return undefined;
  const number = ival.ival;
  return number === undefined ? 0 : typeof number === "number" ? number : undefined;
}

/** JSON of a node without location fields, for comparing expressions structurally. */
export function structuralKey(value) {
  return JSON.stringify(value, (key, inner) => (key === "location" ? undefined : inner));
}

/** Counts nodes and maximum nesting depth of a parse tree, iteratively (no recursion limit issues). */
export function treeSize(root) {
  let nodes = 0;
  let depth = 0;
  const stack = [{ value: root, level: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { value, level } = entry;
    if (typeof value !== "object" || value === null) continue;
    nodes += 1;
    depth = Math.max(depth, level);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      stack.push({ value: child, level: level + 1 });
    }
  }
  return { nodes, depth };
}
