/**
 * A signal that aborts after ms, or as soon as parent aborts. Always call dispose() when the work ends:
 * unlike AbortSignal.timeout with AbortSignal.any, nothing stays in memory afterwards.
 */
export function createDeadline(ms, parent) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new globalThis.DOMException("The operation timed out", "TimeoutError"));
  }, ms);
  const follow = () => controller.abort(parent.reason);
  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });
  return {
    signal: controller.signal,
    expired: () => expired,
    abort: () => controller.abort(),
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", follow);
    },
  };
}
