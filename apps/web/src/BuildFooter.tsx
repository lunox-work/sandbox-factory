/**
 * The version readout at the bottom of every screen. Always visible, because
 * "which build is this?" comes up in support and bug reports.
 *
 * It reports and does not act: bundle and API legitimately differ for a few
 * seconds during a rolling deploy, and a reload prompt on every deploy is one
 * users learn to dismiss.
 */

import {
  commitUrl,
  formatVersion,
  isIdentified,
  releaseUrl,
} from "@sandbox-factory/shared";
import type { BuildInfoDto } from "@sandbox-factory/shared";
import { useEffect, useState } from "react";

import { fetchApiBuild, webBuild } from "./build";

export function BuildFooter() {
  const [apiBuild, setApiBuild] = useState<BuildInfoDto | undefined>(undefined);

  useEffect(() => {
    // Guards against setting state after unmount; StrictMode runs this effect
    // twice in development.
    let cancelled = false;
    void fetchApiBuild().then((info) => {
      if (!cancelled) {
        setApiBuild(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = formatVersion(webBuild);

  const href = commitUrl(webBuild);

  // Only when this build is a release; see `releaseUrl`. Shown alongside the
  // commit link, not instead of it.
  const release = releaseUrl(webBuild);

  // Only a definite disagreement is shown. No answer, or an unidentified build
  // on either side, is not a mismatch; see `sameBuild`.
  const mismatched =
    apiBuild !== undefined &&
    isIdentified(apiBuild) &&
    isIdentified(webBuild) &&
    apiBuild.gitSha !== webBuild.gitSha;

  return (
    <footer className="build">
      {href === undefined ? (
        <span>{label}</span>
      ) : (
        <a href={href} target="_blank" rel="noreferrer" title={buildTitle()}>
          {label}
        </a>
      )}
      {release !== undefined && (
        <a
          className="build-release"
          href={release}
          target="_blank"
          rel="noreferrer"
          title="Release notes and signed artifacts for this version."
        >
          release
        </a>
      )}
      {mismatched && (
        <span className="build-mismatch" title={mismatchTitle(apiBuild)}>
          {/* Not an error: it resolves on the next reload. The tooltip
              carries the detail. */}
          API {formatVersion(apiBuild)}
        </span>
      )}
    </footer>
  );
}

/** The full sha and build time, for the person who needs to quote them. */
function buildTitle(): string {
  if (!isIdentified(webBuild)) {
    return "This build did not record the commit it came from.";
  }
  return `commit ${webBuild.gitSha}\nbuilt ${webBuild.buildTime}\nbranch ${webBuild.gitRef}`;
}

function mismatchTitle(apiBuild: BuildInfoDto): string {
  return (
    `This page was built from ${webBuild.gitShortSha}, ` +
    `the API is running ${apiBuild.gitShortSha}.\n` +
    "Usually a deploy in progress — reload to catch up."
  );
}
