import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";

/**
 * Cheap local routing in front of the analytics planner, so ordinary chat does not cost a planning call.
 * The application supplies what its analytics are about (topicPattern) and, optionally, its own words for
 * questions that are never analytics (generalPattern, for example its document topics); the follow-up
 * and conversational wording below is generic. An earlier analytics answer alone never sends a message to analytics: a follow-up must also
 * read like one (short, and about time, breakdowns, comparisons or chart types).
 */

/** Wording that refines an earlier analytics answer ("what about last month?", "by status instead"). */
const FOLLOW_UP =
  /\b(what about|how about|and (for|in|by|per|the)|same (for|but)|instead|only|just|excluding|without|compare|comparison|vs|versus|split|breakdown|break (it )?down|group(ed)? by|by (day|week|month|quarter|year)|per (day|week|month|quarter|year)|daily|weekly|monthly|quarterly|yearly|today|yesterday|this (week|month|quarter|year)|last (\d+ )?(days?|weeks?|months?|quarters?|years?)|previous (week|month|quarter|year)|since|between|until|from \w+ to|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|\d{4}|chart|graph|table|pie|bar|line|area|doughnut|percentage|share|total|count|how many|number of|trend|average|most|least|top)\b/i;

/** Conversational wording that is clearly not about the numbers, even right after an analytics answer. */
const GENERAL =
  /\b(how (do|does|can|should) (i|we|you)|what is (a|an|the)|why (is|are|do|does)|explain|help me|advice|tips?|recommend|write|draft|email|message|thank(s| you)|hello|hi|hey)\b/i;

const MAX_FOLLOW_UP_CHARS = 120;

/**
 * @param {{ topicPattern: RegExp, generalPattern?: RegExp, maxFollowUpChars?: number }} options
 * @returns {{ isAnalyticsQuestion: (question: string, state?: { afterAnalytics?: boolean }) => boolean }}
 */
export function createAnalyticsRouter(options) {
  if (!(options?.topicPattern instanceof RegExp)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createAnalyticsRouter needs a topicPattern RegExp");
  }
  if (options.generalPattern !== undefined && !(options.generalPattern instanceof RegExp)) {
    throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "createAnalyticsRouter: generalPattern must be a RegExp");
  }
  const plain = (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  const topic = plain(options.topicPattern);
  const consumerGeneral = options.generalPattern === undefined ? null : plain(options.generalPattern);
  const isGeneral = (text) => GENERAL.test(text) || (consumerGeneral !== null && consumerGeneral.test(text));
  const maxFollowUpChars = options.maxFollowUpChars ?? MAX_FOLLOW_UP_CHARS;

  function isAnalyticsQuestion(question, state = {}) {
    if (typeof question !== "string") return false;
    const text = question.trim();
    if (text === "") return false;
    const asksForNumbers = FOLLOW_UP.test(text);
    // "tips to get more orders" names the topic but asks for advice; "what is the total of orders" asks for numbers.
    if (topic.test(text)) return !isGeneral(text) || asksForNumbers;
    if (state.afterAnalytics !== true) return false;
    return text.length <= maxFollowUpChars && asksForNumbers && !isGeneral(text);
  }

  return Object.freeze({ isAnalyticsQuestion });
}
