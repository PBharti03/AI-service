import { AiServiceError } from "../errors/AiServiceError.js";
import { ErrorCodes } from "../errors/ErrorCodes.js";
import { isRegisteredTask } from "./DefineTask.js";

/**
 * @typedef {Object} TaskRegistry
 * @property {readonly string[]} ids
 * @property {(id: string) => AnyTask | undefined} get
 * @property {(task: AnyTask) => boolean} has - True only for the exact task object that was registered.
 */

/** Builds an immutable registry. Duplicate IDs and tasks not created by defineTask are refused. */
export function createTaskRegistry(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (!isRegisteredTask(task)) {
      throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Tasks must be created with defineTask");
    }
    if (byId.has(task.id)) {
      throw new AiServiceError(ErrorCodes.CONFIG_INVALID, "Duplicate task id in registry", {
        details: { taskId: task.id },
      });
    }
    byId.set(task.id, task);
  }

  return Object.freeze({
    ids: Object.freeze([...byId.keys()]),
    get: (id) => byId.get(id),
    has: (task) => isRegisteredTask(task) && byId.get(task.id) === task,
  });
}
