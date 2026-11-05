import { z } from "zod";
import { checkRequirement } from "../context/Authorization.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";

/**
 * Generic tool contract: a named, described operation with a validated input, implemented by the
 * consumer. The package checks the trusted context, the consumer's permission and feature requirements
 * and the input before the consumer's executor runs, then checks the result's shape and size.
 *
 * Only read-only tools exist in this version: defining a tool with access "write" fails at setup.
 * A tool's result goes back to the calling application only; this package never sends it to a model.
 */

const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

const definedTools = new WeakSet();

function configError(message, details) {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, message, details === undefined ? {} : { details });
}

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - Lower-case, for example "orders.count".
 * @property {string} description - What it does, for people and (later) for models.
 * @property {"read"} access - "read" is the only supported value; "write" is refused.
 * @property {import("zod").ZodType} inputSchema - Validated before execute runs (use z.strictObject).
 * @property {import("zod").ZodType} [outputSchema] - When set, execute's result must match it.
 * @property {{ permission?: string, feature?: string }} [requires] - Names the trusted context must grant.
 * @property {number} [timeoutMs] - Default 5000, at most 60000.
 * @property {number} [maxResultBytes] - JSON size limit of the result; default 64 KiB, at most 1 MiB.
 * @property {(input: unknown, call: { context: TrustedContext, signal: AbortSignal }) => unknown | Promise<unknown>} execute
 */

/**
 * Validates a tool definition and returns it frozen. Fails closed (CONFIG_INVALID) on any problem.
 * @param {ToolDefinition} definition
 */
export function defineTool(definition) {
  if (typeof definition !== "object" || definition === null) throw configError("A tool definition must be an object");
  const { name, description, access, inputSchema, outputSchema, requires, timeoutMs = DEFAULT_TIMEOUT_MS, maxResultBytes = DEFAULT_MAX_RESULT_BYTES, execute, ...rest } =
    definition;
  if (Object.keys(rest).length > 0) throw configError("A tool definition has unknown fields", { fields: Object.keys(rest).slice(0, 5).join(",") });
  if (typeof name !== "string" || !TOOL_NAME.test(name)) throw configError("A tool name must be lower-case letters, digits, '.', '_' or '-' (max 64)");
  if (typeof description !== "string" || description.trim() === "" || description.length > 500) throw configError("A tool needs a description of 1-500 characters", { tool: name });
  if (access === "write") throw configError("Only read-only tools are supported: access must be \"read\"", { tool: name });
  if (access !== "read") throw configError("A tool's access must be \"read\"", { tool: name });
  if (!(inputSchema instanceof z.ZodType)) throw configError("A tool needs a Zod inputSchema", { tool: name });
  if (outputSchema !== undefined && !(outputSchema instanceof z.ZodType)) throw configError("A tool's outputSchema must be a Zod schema", { tool: name });
  if (typeof execute !== "function") throw configError("A tool needs an execute function", { tool: name });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw configError(`A tool's timeoutMs must be 1-${String(MAX_TIMEOUT_MS)}`, { tool: name });
  if (!Number.isInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > MAX_RESULT_BYTES) throw configError(`A tool's maxResultBytes must be 1-${String(MAX_RESULT_BYTES)}`, { tool: name });
  const tool = Object.freeze({
    name,
    description: description.trim(),
    access,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    requires: checkRequirement(requires, `Tool ${name}`),
    timeoutMs,
    maxResultBytes,
    execute,
  });
  definedTools.add(tool);
  return tool;
}

export function isTool(value) {
  return typeof value === "object" && value !== null && definedTools.has(value);
}
