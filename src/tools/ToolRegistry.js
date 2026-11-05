import { z } from "zod";
import { assertAuthorized } from "../context/Authorization.js";
import { parseTrustedContext } from "../context/TrustedContext.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { isTool } from "./DefineTool.js";

/**
 * Runs consumer-defined tools (see defineTool): checks the trusted context, the tool's requirements and
 * its input before the consumer's executor runs, then the result's shape and size. Results go back to
 * the calling application only; this package never sends them to a model.
 */

const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function configError(message, details) {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, message, details === undefined ? {} : { details });
}

function grants(context, requires) {
  return (
    (requires.permission === undefined || (context.permissions ?? []).includes(requires.permission)) &&
    (requires.feature === undefined || (context.features ?? []).includes(requires.feature))
  );
}

/**
 * A set of tools with unique names.
 * @param {readonly ReturnType<typeof defineTool>[]} tools
 */
export function createToolRegistry(tools) {
  if (!Array.isArray(tools)) throw configError("createToolRegistry needs an array of tools from defineTool()");
  const byName = new Map();
  for (const tool of tools) {
    if (!isTool(tool)) throw configError("createToolRegistry accepts only tools created with defineTool()");
    if (byName.has(tool.name)) throw configError("Tool names must be unique", { tool: tool.name });
    byName.set(tool.name, tool);
  }

  /** The tools this context may use, described for display or for a model (input as JSON Schema). */
  function list(context) {
    const parsed = parseTrustedContext(context);
    return [...byName.values()]
      .filter((tool) => grants(parsed, tool.requires))
      .map((tool) => Object.freeze({ name: tool.name, description: tool.description, access: tool.access, inputJsonSchema: z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" }) }));
  }

  /**
   * Runs one tool: context, requirements and input are checked first; the executor gets the validated
   * input, the frozen context and an AbortSignal that fires at the timeout or when the caller cancels.
   * Resolves to { tool, output, durationMs }, output being a JSON copy of what the executor returned.
   * @param {string} name
   * @param {unknown} input
   * @param {TrustedContextInput} context
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function run(name, input, context, options = {}) {
    const parsed = parseTrustedContext(context);
    const tool = typeof name === "string" ? byName.get(name) : undefined;
    if (tool === undefined) {
      throw new AiServiceError(ErrorCodes.TOOL_UNKNOWN, "Unknown tool", typeof name === "string" && TOOL_NAME.test(name) ? { details: { tool: name } } : {});
    }
    assertAuthorized(parsed, tool.requires);
    const checked = tool.inputSchema.safeParse(input);
    if (!checked.success) {
      throw new AiServiceError(ErrorCodes.TOOL_INPUT_INVALID, "Tool input is invalid", {
        details: { tool: tool.name, ...summarizeZodError(checked.error, tool.inputSchema) },
      });
    }

    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    if (options.signal?.aborted) throw new AiServiceError(ErrorCodes.CANCELLED, "The tool call was cancelled");
    const started = performance.now();
    let raw;
    try {
      const execution = Promise.resolve().then(() => tool.execute(checked.data, { context: parsed, signal }));
      execution.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
      raw = await Promise.race([
        execution,
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    } catch (error) {
      if (options.signal?.aborted) throw new AiServiceError(ErrorCodes.CANCELLED, "The tool call was cancelled");
      if (timeout.aborted) {
        throw new AiServiceError(ErrorCodes.TOOL_TIMEOUT, "The tool did not finish in time", { retryable: true, details: { tool: tool.name, timeoutMs: tool.timeoutMs } });
      }
      // The consumer's own AiServiceError (for example NOT_AUTHORIZED from its data layer) passes through.
      if (error instanceof AiServiceError) throw error;
      throw new AiServiceError(ErrorCodes.TOOL_EXECUTION_FAILED, "The tool failed", { details: { tool: tool.name }, cause: error });
    }

    let output = raw;
    if (tool.outputSchema !== undefined) {
      const result = tool.outputSchema.safeParse(raw);
      if (!result.success) {
        throw new AiServiceError(ErrorCodes.TOOL_RESULT_INVALID, "The tool returned an invalid result", {
          details: { tool: tool.name, ...summarizeZodError(result.error, tool.outputSchema) },
        });
      }
      output = result.data;
    }
    let json;
    try {
      json = JSON.stringify(output);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new AiServiceError(ErrorCodes.TOOL_RESULT_INVALID, "The tool result is not JSON data", { details: { tool: tool.name } });
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > tool.maxResultBytes) {
      throw new AiServiceError(ErrorCodes.TOOL_RESULT_INVALID, "The tool result exceeds its size limit", { details: { tool: tool.name, bytes, limitBytes: tool.maxResultBytes } });
    }
    return Object.freeze({ tool: tool.name, output: JSON.parse(json), durationMs: Math.round(performance.now() - started) });
  }

  return Object.freeze({ list, run, has: (name) => byName.has(name) });
}
