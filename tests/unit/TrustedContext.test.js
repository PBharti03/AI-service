import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ErrorCodes, parseTrustedContext } from "../../src/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { makeContext } from "../helpers/Fixtures.js";

describe("parseTrustedContext", () => {
  it("accepts a well-formed context and returns a copy", () => {
    const input = makeContext({ metadata: { locale: "hi-IN", channel: "web" } });
    const parsed = parseTrustedContext(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
  });

  it("rejects a missing tenant", async () => {
    const withoutTenant = { ...makeContext() };
    delete withoutTenant.tenantId;
    await expectAiError(() => parseTrustedContext(withoutTenant), ErrorCodes.CONTEXT_INVALID);
  });

  it("rejects unknown fields such as a role or permission claim", async () => {
    await expectAiError(() => parseTrustedContext({ ...makeContext(), role: "ADMIN" }), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(
      () => parseTrustedContext({ ...makeContext(), actor: { type: "USER", userId: "user-0001", isAdmin: true } }),
      ErrorCodes.CONTEXT_INVALID,
    );
  });

  it("rejects malformed identifiers and classifications", async () => {
    await expectAiError(() => parseTrustedContext(makeContext({ tenantId: "tenant 1; DROP" })), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(() => parseTrustedContext(makeContext({ requestId: "" })), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(
      () => parseTrustedContext({ ...makeContext(), dataClassification: "PUBLIC" }),
      ErrorCodes.CONTEXT_INVALID,
    );
    await expectAiError(
      () => parseTrustedContext(makeContext({ permittedTasks: ["Not A Task Id"] })),
      ErrorCodes.CONTEXT_INVALID,
    );
  });

  it("reports schema paths without echoing received values", async () => {
    const error = await expectAiError(
      () => parseTrustedContext(makeContext({ tenantId: "bad value with spaces" })),
      ErrorCodes.CONTEXT_INVALID,
    );
    assert.equal(error.details.paths, "tenantId");
    assert.ok(!JSON.stringify(error.details).includes("bad value"));
    assert.ok(!error.message.includes("bad value"));
  });

  it("rejects non-object input", async () => {
    await expectAiError(() => parseTrustedContext(null), ErrorCodes.CONTEXT_INVALID);
    await expectAiError(() => parseTrustedContext("tenant-0001"), ErrorCodes.CONTEXT_INVALID);
  });
});
