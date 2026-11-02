import { AiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import { isRegisteredTask, type AnyTask } from "./DefineTask";

export interface TaskRegistry {
  readonly ids: readonly string[];
  get(id: string): AnyTask | undefined;
  /** True only for the exact task object that was registered. */
  has(task: AnyTask): boolean;
}

/** Builds an immutable registry. Duplicate IDs and tasks not created by defineTask are refused. */
export function createTaskRegistry(tasks: readonly AnyTask[]): TaskRegistry {
  const byId = new Map<string, AnyTask>();
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
    get: (id: string) => byId.get(id),
    has: (task: AnyTask) => isRegisteredTask(task) && byId.get(task.id) === task,
  });
}
