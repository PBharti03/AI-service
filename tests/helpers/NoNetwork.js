/**
 * Imported first by every test file. Replaces the global fetch so that any
 * code path that was not given an injected fetch fails instead of reaching
 * the network.
 */
export class UnexpectedNetworkError extends Error {
  constructor() {
    super("Network access is disabled in unit tests");
    this.name = "UnexpectedNetworkError";
  }
}

globalThis.fetch = () => Promise.reject(new UnexpectedNetworkError());
