import { classificationRank, type DataClassification } from "../context/DataClassification";
import { AiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import type { ProviderInfo } from "../providers/ChatProvider";

/** A task declares the most sensitive data it was approved to handle. */
export function assertTaskAcceptsClassification(
  taskId: string,
  maxClassification: DataClassification,
  actual: DataClassification,
): void {
  if (classificationRank(actual) > classificationRank(maxClassification)) {
    throw new AiServiceError(ErrorCodes.CLASSIFICATION_NOT_ALLOWED, "Data classification exceeds what the task allows", {
      details: { taskId, classification: actual, reason: "task" },
    });
  }
}

/** A provider lists exactly which classifications it may receive. */
export function assertProviderAcceptsClassification(provider: ProviderInfo, actual: DataClassification): void {
  if (!provider.allowedClassifications.includes(actual)) {
    throw new AiServiceError(ErrorCodes.CLASSIFICATION_NOT_ALLOWED, "Provider is not approved for this data classification", {
      details: { providerId: provider.id, classification: actual, reason: "provider" },
    });
  }
}
