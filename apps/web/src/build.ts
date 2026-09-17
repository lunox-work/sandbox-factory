/**
 * What this bundle was built from, and what the API says it was built from.
 * The one place that reads the injected record, so everything else takes a
 * plain value and is testable without a Vite build.
 */

import {
  buildBanner,
  buildInfoSchema,
  unknownBuildInfo,
  type BuildInfoDto,
} from "@sandbox-factory/shared";

import injected from "virtual:build-info";

/**
 * This bundle's own record, frozen at build time: a tab open since before a
 * deploy keeps reporting the build it is running, which is what makes
 * comparing it against the API meaningful.
 *
 * Parsed with a fallback rather than thrown on, so broken plugin plumbing
 * shows "0.0.0" instead of a blank page.
 */
export const webBuild: BuildInfoDto = ((): BuildInfoDto => {
  const parsed = buildInfoSchema.safeParse(injected);
  return parsed.success ? parsed.data : unknownBuildInfo;
})();

/**
 * Asks the API what it is running. Returns undefined on any failure, including
 * an unparseable body such as a proxy's HTML error page; the footer then
 * skips the comparison rather than crashing.
 */
export async function fetchApiBuild(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BuildInfoDto | undefined> {
  try {
    const response = await fetchImpl("/version");
    if (!response.ok) {
      return undefined;
    }
    const parsed = buildInfoSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the build to the console once, on boot, where dev tools, session
 * replays and screenshots pick it up. `console.info` so it can be filtered.
 */
export function logBuild(console_: Pick<Console, "info"> = console): void {
  console_.info(buildBanner("sandbox-factory", webBuild));
}
