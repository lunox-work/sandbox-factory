/**
 * What this bundle was built from, and what the API it is talking to says it
 * was built from.
 *
 * The one place that reads the injected record, so everything else takes a
 * plain value — which is also what makes the components below testable without
 * a Vite build.
 */

import {
  buildBanner,
  buildInfoSchema,
  unknownBuildInfo,
  type BuildInfoDto,
} from "@sandbox-factory/shared";

import injected from "virtual:build-info";

/**
 * This bundle's own record.
 *
 * Frozen at build time, which is the point: a tab that has been open since
 * before a deploy keeps reporting the build it is actually running rather than
 * the one currently deployed. That is what makes comparing it against the API
 * meaningful.
 *
 * Parsed rather than trusted, and falling back rather than throwing. The value
 * arrives from a Vite plugin, and a version readout is the last thing that
 * should be able to take the app down if that plumbing ever breaks — showing
 * "0.0.0" is a bad day, a ReferenceError at module load is a blank page.
 */
export const webBuild: BuildInfoDto = ((): BuildInfoDto => {
  const parsed = buildInfoSchema.safeParse(injected);
  return parsed.success ? parsed.data : unknownBuildInfo;
})();

/**
 * Asks the API what it is running.
 *
 * Parsed rather than cast: this crosses the network, and an unparseable body —
 * an HTML error page from a proxy, most likely — should read as "could not
 * determine" rather than crash the footer that renders it.
 *
 * Returns undefined on any failure. A version readout is not worth an error
 * boundary; the UI simply says it does not know.
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
 * Writes the build to the console once, on boot.
 *
 * Worth the line because it survives where the footer does not: it is in the
 * console of a user who has been asked to open dev tools, it lands in a session
 * replay, and it is already there in a screenshot taken for another reason.
 *
 * `console.info` rather than `log`, so it can be filtered out.
 */
export function logBuild(console_: Pick<Console, "info"> = console): void {
  console_.info(buildBanner("sandbox-factory", webBuild));
}
