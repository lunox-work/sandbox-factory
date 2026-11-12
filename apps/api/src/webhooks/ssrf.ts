/**
 * Where a webhook may be sent: the guard between a URL a workspace typed
 * and the API's own network.
 *
 * - **https only.** http is accepted only to `localhost` (and loopback
 *   literals) when `allowLocalHttp` is set, which the server sets only
 *   when its own public URL is local: development, never production.
 * - **No private destination.** Every address a host resolves to is
 *   checked, and one refused address refuses the host: private
 *   (RFC 1918, IPv6 unique local), loopback, link-local (which holds the
 *   cloud metadata service, 169.254.169.254 and fd00:ec2::254), CGNAT,
 *   multicast, reserved and documentation ranges, and IPv4 inside IPv6
 *   (mapped, NAT64) by the IPv4 it carries.
 * - **Checked where the connection is made.** `guardedLookup` is the
 *   socket's resolver, so the address checked is the address connected
 *   to: a name that answers a public address to a first lookup and a
 *   private one to the next (DNS rebinding) gains nothing. An IP literal,
 *   which the socket does not resolve, is checked before the request.
 * - **No redirects.** The sender's transport does not follow them; a 3xx
 *   is a failed attempt.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

export interface UrlPolicy {
  /** http to localhost, for development; off in production. */
  readonly allowLocalHttp: boolean;
}

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL; readonly allowLoopback: boolean }
  | { readonly ok: false; readonly reason: string };

export class WebhookAddressRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookAddressRefused";
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** An IPv6 address as eight 16-bit groups, or null if it is not one. */
function groups(address: string): number[] | null {
  let text = address.toLowerCase();
  // A dotted IPv4 tail is the last two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const octets = dotted[1].split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text =
      text.slice(0, -dotted[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [
    ...left,
    ...Array<string>(Math.max(missing, 0)).fill("0"),
    ...right,
  ];
  const parsed = all.map((group) => Number.parseInt(group, 16));
  return parsed.every((group) => group >= 0 && group <= 0xffff) ? parsed : null;
}

/** The IPv4 address an IPv6 one carries (mapped or NAT64), if any. */
function embeddedIPv4(address: string): string | null {
  const parts = groups(address);
  if (parts === null) return null;
  const [a, b, c, d, e, f, g = 0, h = 0] = parts;
  const mapped =
    a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  const nat64 =
    a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  if (!mapped && !nat64) return null;
  return [g >> 8, g & 0xff, h >> 8, h & 0xff].join(".");
}

/** Whether a webhook may not connect to `address`. */
export function isForbiddenAddress(
  address: string,
  allowLoopback = false,
): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const inner = embeddedIPv4(address);
    if (inner !== null) return isForbiddenAddress(inner, allowLoopback);
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if (allowLoopback && loopback.check(address, type)) return false;
  return blocked.check(address, type);
}

function isLocalName(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 &&
      loopback.check(host, isIP(host) === 4 ? "ipv4" : "ipv6"))
  );
}

/**
 * Whether the server's own public origin is local, which is how it knows
 * it is a development server and may send webhooks over http to localhost.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether `raw` may be a webhook's URL, before anything is resolved: the
 * scheme, no credentials in it, and no refused IP literal.
 */
export function checkWebhookUrl(raw: string, policy: UrlPolicy): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a URL." };
  }
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "A webhook URL may not carry credentials." };
  const local = isLocalName(url.hostname);
  const allowLoopback = policy.allowLocalHttp && local;
  if (url.protocol === "http:" && !allowLoopback)
    return {
      ok: false,
      reason: policy.allowLocalHttp
        ? "A webhook URL must be https, or http to localhost."
        : "A webhook URL must be https.",
    };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: "A webhook URL must be https." };
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0 && isForbiddenAddress(literal, allowLoopback))
    return {
      ok: false,
      reason: "A webhook may not be sent to a private or reserved address.",
    };
  return { ok: true, url, allowLoopback };
}

type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A resolver for the socket that refuses a host any of whose addresses is
 * forbidden, and answers in the form the socket asked for.
 */
export function guardedLookup(
  allowLoopback: boolean,
  resolve: Resolver = dnsLookup as unknown as Resolver,
) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: LookupCallback,
  ): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, []);
        return;
      }
      const refused = addresses.find(({ address }) =>
        isForbiddenAddress(address, allowLoopback),
      );
      const first = addresses[0];
      if (refused !== undefined || first === undefined) {
        callback(
          new WebhookAddressRefused(
            first === undefined
              ? `${hostname} resolved to no address.`
              : `${hostname} resolves to a private or reserved address.`,
          ),
          [],
        );
        return;
      }
      if (typeof options === "object" && options.all === true)
        callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}
