import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { taskIdSchema } from "../tasks/TaskId.js";
import { summarizeZodError } from "../validation/ZodIssues.js";
import { dataClassificationSchema } from "./DataClassification.js";

const referenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

/**
 * Identity and authorization facts about one AI request.
 *
 * The application backend builds this from its own authenticated session and
 * authorization checks. This package only validates the shape: it never
 * authenticates anyone, never grants permissions, and never reads identity
 * from prompts, task input or model output.
 */
export const trustedContextSchema = z.strictObject({
  applicationId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  tenantId: referenceSchema,
  actor: z.strictObject({
    type: z.enum(["USER", "SYSTEM"]),
    userId: referenceSchema,
  }),
  requestId: referenceSchema,
  permittedTasks: z.array(taskIdSchema).max(100).readonly(),
  dataClassification: dataClassificationSchema,
  metadata: z
    .strictObject({
      locale: z
        .string()
        .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
        .optional(),
      channel: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,31}$/)
        .optional(),
    })
    .optional(),
});

/**
 * Validates the context and returns a deep-frozen copy. Freezing keeps the
 * validated tenant and actor identity fixed for the whole task, including
 * when the context is passed to application hooks and used for usage records.
 */
export function parseTrustedContext(value) {
  const result = trustedContextSchema.safeParse(value);
  if (!result.success) {
    throw new AiServiceError(ErrorCodes.CONTEXT_INVALID, "Trusted context is invalid", {
      details: summarizeZodError(result.error, trustedContextSchema),
    });
  }
  const { actor, permittedTasks, metadata, ...rest } = result.data;
  return Object.freeze({
    ...rest,
    actor: Object.freeze({ ...actor }),
    permittedTasks: Object.freeze([...permittedTasks]),
    ...(metadata === undefined ? {} : { metadata: Object.freeze({ ...metadata }) }),
  });
}
