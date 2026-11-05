import { z } from "zod";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { summarizeZodError } from "../validation/ZodIssues.js";

/**
 * Who the assistant is speaking for. Each application that uses this package defines one profile in its
 * own code (never from user input): the greeting, "what can you do?" answers and refusals for topics the
 * application does not cover are all based on it, so the same package answers differently in each
 * application that uses it.
 *
 * @typedef {Object} ApplicationProfile
 * @property {string} id - Matches the trusted context's applicationId (for example "example-app").
 * @property {string} name - Shown to users, for example "Example App".
 * @property {string} description - One or two sentences on what the application is for.
 * @property {readonly string[]} capabilities - What the assistant can help with here, as short phrases.
 * @property {readonly string[]} outOfScope - Topics the application does not cover (for example "payments").
 */

const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  capabilities: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  outOfScope: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Optional: the business domain in a few words, for example "online retail" or "property sales". */
  domain: z.string().trim().min(1).max(60).optional(),
  /** Optional: the application's own words and what they mean, so answers use its terminology. */
  terminology: z
    .array(z.strictObject({ term: z.string().trim().min(1).max(40), meaning: z.string().trim().min(1).max(160) }))
    .max(30)
    .default([]),
});

const definedProfiles = new WeakSet();

/**
 * Validates and freezes an application profile.
 * @param {Partial<ApplicationProfile>} input
 * @returns {ApplicationProfile}
 */
export function defineApplicationProfile(input) {
  const result = profileSchema.safeParse(input);
  if (!result.success) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Application profile is invalid", {
      details: summarizeZodError(result.error, profileSchema),
    });
  }
  const profile = Object.freeze({
    ...result.data,
    capabilities: Object.freeze([...result.data.capabilities]),
    outOfScope: Object.freeze([...result.data.outOfScope]),
    terminology: Object.freeze(result.data.terminology.map((entry) => Object.freeze({ ...entry }))),
  });
  definedProfiles.add(profile);
  return profile;
}

/** @returns {value is ApplicationProfile} */
export function isApplicationProfile(value) {
  return typeof value === "object" && value !== null && definedProfiles.has(value);
}

/**
 * The profile as task data: name, description, capabilities and out-of-scope topics only.
 * @param {ApplicationProfile} profile
 */
export function profileForPrompt(profile) {
  return {
    name: profile.name,
    description: profile.description,
    capabilities: [...profile.capabilities],
    outOfScope: [...profile.outOfScope],
  };
}

/**
 * Throws unless the request's trusted applicationId is this profile's: an application can only speak
 * as itself, and only read its own documents.
 * @param {ApplicationProfile} profile
 * @param {{ applicationId: string }} context
 */
export function assertProfileMatchesContext(profile, context) {
  if (context?.applicationId !== profile.id) {
    throw new AiServiceError(
      ErrorCodes.TASK_NOT_PERMITTED,
      "The request's application does not match the assistant's application",
      {
        details: { applicationId: profile.id },
      },
    );
  }
}
