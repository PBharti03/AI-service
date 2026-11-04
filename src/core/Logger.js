/**
 * @typedef {string | number | boolean | null | undefined} LogValue
 */

/**
 * @typedef {Readonly<Record<string, LogValue>>} LogMeta
 */

/**
 * Injected logger. The signature matches b2y-logger / winston (message, meta). The package only ever passes metadata: identifiers, codes, counts and timings. Prompt text, task input and model output are never logged.
 * @typedef {Object} AiLogger
 * @property {(message: string, meta?: LogMeta) => void} debug
 * @property {(message: string, meta?: LogMeta) => void} info
 * @property {(message: string, meta?: LogMeta) => void} warn
 * @property {(message: string, meta?: LogMeta) => void} error
 */

/**
 * Injected logger. The signature matches b2y-logger / winston (message, meta).
 * The package only ever passes metadata: identifiers, codes, counts and
 * timings. Prompt text, task input and model output are never logged.
 */

export const noopLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
