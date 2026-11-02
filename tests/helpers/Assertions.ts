import assert from "node:assert/strict";
import { AiServiceError, type ErrorCode } from "../../src";

/** Runs the action and asserts it fails with an AiServiceError of the given code. */
export async function expectAiError(action: () => unknown, code: ErrorCode): Promise<AiServiceError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiServiceError, `expected AiServiceError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly meta: unknown;
}

export function recordingLogger(): {
  readonly entries: LogEntry[];
  readonly logger: Record<"debug" | "info" | "warn" | "error", (message: string, meta?: unknown) => void>;
} {
  const entries: LogEntry[] = [];
  const at = (level: string) => (message: string, meta?: unknown) => {
    entries.push({ level, message, meta });
  };
  return { entries, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}
