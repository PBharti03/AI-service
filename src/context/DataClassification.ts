import { z } from "zod";

/** Ordered from least to most sensitive. */
export const DATA_CLASSIFICATIONS = ["SYNTHETIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

export function classificationRank(classification: DataClassification): number {
  return DATA_CLASSIFICATIONS.indexOf(classification);
}
