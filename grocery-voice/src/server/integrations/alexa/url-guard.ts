import { isIP } from "node:net";

/**
 * The Home Assistant URL is user-supplied and fetched by our server, so it is
 * a server-side request forgery vector. In production we require https and
 * refuse loopback, private, link-local and metadata addresses given as IP
 * literals or well-known local hostnames. (DNS names that resolve to private
 * addresses are not caught here; see docs/integrations.md.)
 */
export function assertSafeHomeAssistantUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Home Assistant URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("Do not put credentials in the URL");
  if (url.search || url.hash) throw new Error("Home Assistant URL must not include a query or fragment");
  if (allowPrivate) {
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use http or https");
    return url;
  }
  if (url.protocol !== "https:") throw new Error("Home Assistant URL must use https");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Local hostnames are not allowed; use your Home Assistant Cloud or public URL");
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new Error("Private network addresses are not allowed");
  }
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("::ffff:")
  );
}
