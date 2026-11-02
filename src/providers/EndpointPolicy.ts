import { AiServiceError } from "../errors/AiServiceError";
import { ErrorCodes } from "../errors/ErrorCodes";
import type { ProviderKind } from "./ChatProvider";

export interface EndpointPolicyOptions {
  readonly providerKind: ProviderKind;
  /** Permit plain HTTP to allow-listed private IPs and single-label hosts (for example "vllm" on a Docker network). */
  readonly allowInsecurePrivateHttp: boolean;
  /** Administrator-approved hosts for SELF_HOSTED providers. Every self-hosted host must be listed. Ignored for PAID. */
  readonly allowedHosts: readonly string[];
}

/** The only external (PAID) endpoints the package will call: HTTPS on the default port, exact hostname. */
export const APPROVED_PAID_HOSTS: readonly string[] = Object.freeze(["api.groq.com"]);

type HostClass = "loopback" | "private" | "internal-name" | "public" | "forbidden";

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Validates a provider base URL before any request is made.
 *
 * - PAID providers: HTTPS, default port, and a hostname in APPROVED_PAID_HOSTS.
 * - SELF_HOSTED providers: the host must be in the administrator allow-list.
 *   Nothing is trusted implicitly, including single-label names and private
 *   IPs. Plain HTTP is only allowed to allow-listed loopback hosts, or to
 *   allow-listed private / single-label hosts when allowInsecurePrivateHttp
 *   is set; never to public hosts. Approved PAID hosts cannot be configured as
 *   SELF_HOSTED, so the paid-provider opt-in cannot be bypassed.
 * - Always refused: link-local (cloud metadata), unspecified, multicast and
 *   IPv4-mapped IPv6 addresses; credentials, queries and fragments in the URL.
 *
 * DNS is not resolved. Node's built-in fetch does not expose a supported way
 * to check the address it actually connects to, so a resolved-address check
 * here could not be guaranteed to match the connection (DNS rebinding). The
 * allow-list is the control: administrators must only list names whose DNS
 * they control.
 */
export function resolveProviderBaseUrl(baseUrl: string, options: EndpointPolicyOptions): URL {
  const url = parseBaseUrl(baseUrl);
  const host = hostOf(url);
  const hostClass = classifyHost(host);

  if (hostClass === "forbidden") {
    throw configError("Provider host is not permitted", "forbidden_address");
  }

  if (options.providerKind === "PAID") {
    if (url.protocol !== "https:" || url.port !== "" || !APPROVED_PAID_HOSTS.includes(host)) {
      throw configError("Paid providers require HTTPS to an approved hostname", "paid_endpoint_not_allowed");
    }
    return withTrailingSlash(url);
  }

  if (APPROVED_PAID_HOSTS.includes(host)) {
    throw configError("Hosted provider endpoints must be configured as PAID providers", "paid_host_requires_paid_kind");
  }
  const allowedHosts = options.allowedHosts.map(normalizeAllowedHost);
  if (!allowedHosts.includes(host)) {
    throw configError("Self-hosted provider host is not in the administrator allow-list", "host_not_allowlisted");
  }

  if (url.protocol === "http:") {
    const privateNetwork = hostClass === "private" || hostClass === "internal-name";
    if (hostClass !== "loopback" && !(privateNetwork && options.allowInsecurePrivateHttp)) {
      throw configError(
        "Plain HTTP is only allowed for loopback, or private hosts when allowInsecurePrivateHttp is set",
        "insecure_http",
      );
    }
  }

  return withTrailingSlash(url);
}

/**
 * Normalises an allow-list entry the same way URLs are normalised, so
 * "LOCALHOST", "127.1" and "::1" compare correctly. Entries must be a bare
 * hostname or IP address (no scheme, port or path).
 */
export function normalizeAllowedHost(entry: string): string {
  const bracketed = entry.includes(":") ? `[${entry.replace(/^\[|\]$/g, "")}]` : entry;
  let url: URL;
  try {
    url = new URL(`http://${bracketed}/`);
  } catch {
    throw configError("Allow-listed host is invalid", "invalid_allowed_host");
  }
  if (url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw configError("Allow-listed host must be a bare hostname or IP address", "invalid_allowed_host");
  }
  const host = hostOf(url);
  if (classifyHost(host) === "forbidden") {
    throw configError("Allow-listed host is not permitted", "forbidden_address");
  }
  return host;
}

/** Returns the base URL's host if it is loopback; otherwise throws CONFIG_INVALID. */
export function loopbackHostOf(baseUrl: string): string {
  const host = hostOf(parseBaseUrl(baseUrl));
  if (classifyHost(host) !== "loopback") {
    throw configError("This provider preset only allows loopback endpoints", "loopback_required");
  }
  return host;
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw configError("Provider baseUrl is not a valid URL", "invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configError("Provider baseUrl must use http or https", "unsupported_protocol");
  }
  if (url.username !== "" || url.password !== "") {
    throw configError("Provider baseUrl must not contain credentials", "credentials_in_url");
  }
  if (url.search !== "" || url.hash !== "") {
    throw configError("Provider baseUrl must not contain a query or fragment", "query_or_fragment");
  }
  return url;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function classifyHost(host: string): HostClass {
  if (host === "localhost") {
    return "loopback";
  }
  if (IPV4_PATTERN.test(host)) {
    return classifyIPv4(host);
  }
  if (host.includes(":")) {
    return classifyIPv6(host);
  }
  if (host.length > 253 || !HOSTNAME_PATTERN.test(host)) {
    return "forbidden";
  }
  return host.includes(".") ? "public" : "internal-name";
}

function classifyIPv4(host: string): HostClass {
  const octets = host.split(".").map(Number);
  const [a = -1, b = -1] = octets;
  if (octets.some((octet) => octet > 255)) {
    return "forbidden";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 0 || a >= 224 || (a === 169 && b === 254)) {
    return "forbidden";
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  return "public";
}

function classifyIPv6(host: string): HostClass {
  if (host === "::1") {
    return "loopback";
  }
  if (host === "::" || host.startsWith("::ffff:")) {
    return "forbidden";
  }
  const firstHextet = Number.parseInt(host.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstHextet)) {
    return "forbidden";
  }
  if ((firstHextet & 0xffc0) === 0xfe80 || (firstHextet & 0xff00) === 0xff00) {
    return "forbidden";
  }
  if ((firstHextet & 0xfe00) === 0xfc00) {
    return "private";
  }
  return "public";
}

function withTrailingSlash(url: URL): URL {
  const normalized = new URL(url.href);
  if (!normalized.pathname.endsWith("/")) {
    normalized.pathname = `${normalized.pathname}/`;
  }
  return normalized;
}

function configError(message: string, reason: string): AiServiceError {
  return new AiServiceError(ErrorCodes.CONFIG_INVALID, message, { details: { reason } });
}
