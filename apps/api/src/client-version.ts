/**
 * A floor under the command-line clients: `Lunox-Client-Version:
 * <client>/<semver>` on a request from `duediligence` or `carveout`, and a
 * minimum per client from `MIN_CLIENT_VERSIONS`
 * (`duediligence=0.4.0,carveout=0.2.0`; empty, no floor). A client older
 * than its floor is answered `426` with
 * `{ error, code: "client_too_old", minimumVersion }` before anything else
 * runs, so it can tell the person to upgrade. A request without the
 * header, from a client with no floor, or with a version that does not
 * parse, is served as before: the floor stops old clients, it does not
 * authenticate new ones.
 */

import type { MiddlewareHandler } from "hono";

export const CLIENT_VERSION_HEADER = "Lunox-Client-Version";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CLIENT = /^[a-z][a-z0-9-]{0,39}$/;

/** `[major, minor, patch]` and whether it is a pre-release, or null. */
function parse(version: string): [number, number, number, boolean] | null {
  const match = SEMVER.exec(version);
  if (match === null) return null;
  const [, major = "0", minor = "0", patch = "0"] = match;
  return [Number(major), Number(minor), Number(patch), version.includes("-")];
}

/** Whether `version` is below `minimum`; a pre-release is below its release. */
export function isOlder(version: string, minimum: string): boolean {
  const given = parse(version);
  const floor = parse(minimum);
  if (given === null || floor === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (given[index] as number) - (floor[index] as number);
    if (difference !== 0) return difference < 0;
  }
  return given[3] && !floor[3];
}

/**
 * `MIN_CLIENT_VERSIONS` as a map, or the reason it cannot be read: each
 * entry `client=x.y.z`, comma-separated, each client once.
 */
export function parseClientFloors(
  value: string | undefined,
):
  | { ok: true; floors: Readonly<Record<string, string>> }
  | { ok: false; reason: string } {
  const floors: Record<string, string> = {};
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const [client = "", version = "", extra] = trimmed.split("=");
    if (
      extra !== undefined ||
      !CLIENT.test(client.trim()) ||
      parse(version.trim()) === null
    )
      return {
        ok: false,
        reason: `MIN_CLIENT_VERSIONS: "${trimmed}" is not client=x.y.z.`,
      };
    if (Object.hasOwn(floors, client.trim()))
      return {
        ok: false,
        reason: `MIN_CLIENT_VERSIONS names ${client.trim()} twice.`,
      };
    floors[client.trim()] = version.trim();
  }
  return { ok: true, floors };
}

export function clientVersionFloor(
  floors: Readonly<Record<string, string>>,
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(CLIENT_VERSION_HEADER)?.trim() ?? "";
    const slash = header.indexOf("/");
    const client = header.slice(0, slash).toLowerCase();
    const version = header.slice(slash + 1);
    const minimum =
      slash > 0 && Object.hasOwn(floors, client) ? floors[client] : undefined;
    if (minimum !== undefined && isOlder(version, minimum))
      return c.json(
        {
          error: `This version of ${client} is too old for this server. Upgrade to ${minimum} or later.`,
          code: "client_too_old",
          minimumVersion: minimum,
        },
        426,
      );
    await next();
    return;
  };
}
