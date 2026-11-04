import { z } from "zod";

/** Ordered from least to most sensitive. */
export const DATA_CLASSIFICATIONS = ["SYNTHETIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

export function classificationRank(classification) {
  return DATA_CLASSIFICATIONS.indexOf(classification);
}
