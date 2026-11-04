import assert from "node:assert/strict";
import { AiServiceError } from "../../src/index.js";

/** Runs the action and asserts it fails with an AiServiceError of the given code. */
export async function expectAiError(action, code) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiServiceError, `expected AiServiceError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

export function recordingLogger() {
  const entries = [];
  const at = (level) => (message, meta) => {
    entries.push({ level, message, meta });
  };
  return { entries, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}
