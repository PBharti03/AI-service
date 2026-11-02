import { z } from "zod";

/** Dotted lowercase identifiers such as "lead.summary". */
export const taskIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
