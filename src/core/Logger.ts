export type LogValue = string | number | boolean | null | undefined;
export type LogMeta = Readonly<Record<string, LogValue>>;

/**
 * Injected logger. The signature matches b2y-logger / winston (message, meta).
 * The package only ever passes metadata: identifiers, codes, counts and
 * timings. Prompt text, task input and model output are never logged.
 */
export interface AiLogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export const noopLogger: AiLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
