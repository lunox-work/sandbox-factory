/**
 * The version readout at the bottom of every screen.
 *
 * Small, muted and always present: the question it answers — "which build am I
 * looking at?" — comes up during support and bug reports, and a readout behind
 * a menu is one that has to be explained over the phone before it can be read
 * out.
 *
 * It reports, and does not act. A mismatch between this bundle and the API is
 * shown rather than corrected: during a rolling deploy the two legitimately
 * differ for a few seconds, and a reload prompt on every deploy is one users
 * learn to dismiss without reading.
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
    // Guards against setting state after unmount. StrictMode runs this effect
    // twice in development, and the first run's response arrives after its own
    // cleanup has already run.
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

  // The commit, always — it is the field that identifies this exact build, and
  // it resolves for every build there is.
  const href = commitUrl(webBuild);

  // The release, only when this build *is* one. Undefined for the commits
  // between two releases, which carry the previous version without being it;
  // see `releaseUrl`. Shown in addition to the commit rather than instead of
  // it, because they answer different questions — "what code is this?" versus
  // "what shipped, and what are its signed artifacts?" — and only the first
  // has an answer for most builds.
  const release = releaseUrl(webBuild);

  // Only a definite disagreement is worth showing. An API that did not answer,
  // or either side reporting an unidentified build, leaves the question
  // unanswered rather than answered "no" — see `sameBuild`.
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
          {/* Not an error: it resolves itself on the next reload. The tooltip
              carries the detail rather than the footer spelling it out. */}
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
