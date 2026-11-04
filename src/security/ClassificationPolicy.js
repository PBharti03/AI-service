import { classificationRank } from "../context/DataClassification.js";
import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";

/** A task declares the most sensitive data it was approved to handle. */
export function assertTaskAcceptsClassification(taskId, maxClassification, actual) {
  if (classificationRank(actual) > classificationRank(maxClassification)) {
    throw new AiServiceError(ErrorCodes.CLASSIFICATION_NOT_ALLOWED, "Data classification exceeds what the task allows", {
      details: { taskId, classification: actual, reason: "task" },
    });
  }
}

/** A provider lists exactly which classifications it may receive. */
export function assertProviderAcceptsClassification(provider, actual) {
  if (!provider.allowedClassifications.includes(actual)) {
    throw new AiServiceError(ErrorCodes.CLASSIFICATION_NOT_ALLOWED, "Provider is not approved for this data classification", {
      details: { providerId: provider.id, classification: actual, reason: "provider" },
    });
  }
}
