import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import type { PostValidationResult } from "./DefineTask";

export const UNKNOWN_INTENT = "UNKNOWN";

const INTENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Output schema for intent-classification tasks. UNKNOWN is always one of the
 * allowed intents, so the model has an explicit way to decline instead of
 * forcing a guess.
 */
export function intentOutputSchema<const TIntents extends readonly string[]>(intents: TIntents) {
  const unique = new Set(intents);
  const valid =
    intents.length > 0 &&
    intents.length <= 50 &&
    unique.size === intents.length &&
    !unique.has(UNKNOWN_INTENT) &&
    intents.every((intent) => INTENT_NAME.test(intent));
  if (!valid) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Intent list is invalid", {
      details: { reason: "intents must be unique UPPER_SNAKE names and must not include UNKNOWN" },
    });
  }

  return z.strictObject({
    intent: z.enum([...intents, UNKNOWN_INTENT]),
    confidence: z.number().min(0).max(1),
    ambiguous: z.boolean(),
  });
}

/** postValidate helper: ambiguous or low-confidence classifications fail closed. */
export function requireConfidentIntent(
  minConfidence: number,
): (output: { readonly confidence: number; readonly ambiguous: boolean }) => PostValidationResult {
  if (!(minConfidence > 0 && minConfidence <= 1)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "minConfidence must be in (0, 1]");
  }
  return (output) => {
    if (output.ambiguous) {
      return { ok: false, reason: "ambiguous" };
    }
    if (output.confidence < minConfidence) {
      return { ok: false, reason: "low_confidence" };
    }
    return { ok: true };
  };
}
