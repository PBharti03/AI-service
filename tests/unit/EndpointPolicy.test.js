import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ErrorCodes } from "../../src/index.js";
import { resolveProviderBaseUrl } from "../../src/providers/EndpointPolicy.js";
import { expectAiError } from "../helpers/Assertions.js";

const selfHosted = { providerKind: "SELF_HOSTED", allowInsecurePrivateHttp: false, allowedHosts: [] };
const privateHttp = { ...selfHosted, allowInsecurePrivateHttp: true };
const loopbackListed = { ...selfHosted, allowedHosts: ["localhost", "127.0.0.1", "::1"] };
const privateHosts = ["10.0.0.5", "172.20.1.9", "192.168.1.20", "vllm"];
const privateListed = { ...selfHosted, allowedHosts: privateHosts };
const privateHttpListed = { ...privateHttp, allowedHosts: privateHosts };

async function expectRejected(url, options, reason) {
  const error = await expectAiError(() => resolveProviderBaseUrl(url, options), ErrorCodes.CONFIG_INVALID);
  if (reason !== undefined) {
    assert.equal(error.details.reason, reason);
  }
}

describe("resolveProviderBaseUrl", () => {
  it("accepts allow-listed loopback over plain HTTP and normalises a trailing slash", () => {
    assert.equal(resolveProviderBaseUrl("http://localhost:11434/v1", loopbackListed).href, "http://localhost:11434/v1/");
    assert.equal(resolveProviderBaseUrl("http://127.0.0.1:8000/v1/", loopbackListed).href, "http://127.0.0.1:8000/v1/");
    assert.equal(resolveProviderBaseUrl("http://[::1]:8000/v1", loopbackListed).hostname, "[::1]");
  });

  it("allows plain HTTP to allow-listed private hosts only when explicitly enabled", async () => {
    await expectRejected("http://10.0.0.5:8000/v1", privateListed, "insecure_http");
    await expectRejected("http://vllm:8000/v1", privateHttp, "host_not_allowlisted");
    assert.ok(resolveProviderBaseUrl("http://10.0.0.5:8000/v1", privateHttpListed));
    assert.ok(resolveProviderBaseUrl("http://172.20.1.9:8000/v1", privateHttpListed));
    assert.ok(resolveProviderBaseUrl("http://192.168.1.20:8000/v1", privateHttpListed));
    assert.ok(resolveProviderBaseUrl("http://vllm:8000/v1", privateHttpListed));
    assert.ok(resolveProviderBaseUrl("https://10.0.0.5/v1", privateListed));
  });

  it("refuses self-hosted endpoints that are not allow-listed", async () => {
    await expectRejected("https://inference.example.com/v1", selfHosted, "host_not_allowlisted");
    await expectRejected("https://8.8.8.8/v1", selfHosted, "host_not_allowlisted");
    await expectRejected("http://172.32.0.1/v1", privateHttp, "host_not_allowlisted");
    assert.ok(
      resolveProviderBaseUrl("https://inference.example.com/v1", { ...selfHosted, allowedHosts: ["inference.example.com"] }),
    );
    await expectRejected(
      "http://inference.example.com/v1",
      { ...privateHttp, allowedHosts: ["inference.example.com"] },
      "insecure_http",
    );
  });

  it("always refuses metadata, link-local, unspecified, multicast and mapped addresses", async () => {
    for (const url of [
      "http://169.254.169.254/latest",
      "https://169.254.169.254/",
      "http://0xa9.0xfe.0xa9.0xfe/",
      "http://0.0.0.0:8000/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expectRejected(url, { ...privateHttp, allowedHosts: ["169.254.169.254"] }, "forbidden_address");
    }
  });

  it("resolves numeric host tricks before classifying them", () => {
    assert.equal(resolveProviderBaseUrl("http://2130706433:8000/v1", loopbackListed).hostname, "127.0.0.1");
  });

  it("refuses credentials, queries, fragments, other protocols and invalid URLs", async () => {
    await expectRejected("http://user:pass@localhost:11434/v1", selfHosted, "credentials_in_url");
    await expectRejected("http://localhost:11434/v1?key=1", selfHosted, "query_or_fragment");
    await expectRejected("http://localhost:11434/v1#x", selfHosted, "query_or_fragment");
    await expectRejected("ftp://localhost/v1", selfHosted, "unsupported_protocol");
    await expectRejected("file:///etc/passwd", selfHosted, "unsupported_protocol");
    await expectRejected("not a url", selfHosted, "invalid_url");
  });

  it("requires HTTPS and an approved host for paid providers", async () => {
    const paid = { providerKind: "PAID", allowInsecurePrivateHttp: false, allowedHosts: [] };
    assert.ok(resolveProviderBaseUrl("https://api.groq.com/openai/v1", paid));
    await expectRejected("http://api.groq.com/openai/v1", paid, "paid_endpoint_not_allowed");
    await expectRejected(
      "https://api.example.com/v1",
      { ...paid, allowedHosts: ["api.example.com"] },
      "paid_endpoint_not_allowed",
    );
    await expectRejected(
      "https://api.groq.com/openai/v1",
      { ...selfHosted, allowedHosts: ["api.groq.com"] },
      "paid_host_requires_paid_kind",
    );
  });
});
