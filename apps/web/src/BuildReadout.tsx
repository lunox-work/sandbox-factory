/**
 * The build readout: which version, which commit, and whether the API agrees.
 *
 * Shared by the two places that show it — the avatar menu, and the signed-out
 * screen, which cannot reach the menu because there is no avatar until someone
 * signs in. "Which build is this?" is asked of a broken sign-in more than of
 * anything else, so that screen needs the same facts, not just the version.
 *
 * The one thing that differs between the two is how a link is wrapped. Inside
 * a Radix menu the links must be `DropdownMenuItem`s or no keyboard can reach
 * them: Radix walks the arrow keys over its own items and holds Tab inside the
 * open menu. On the sign-in page there is no menu, and a `DropdownMenuItem`
 * outside a `Menu` throws. So the caller passes the wrapper in; it is not a
 * detail this component can pick for itself.
 */

import { commitUrl, isIdentified, releaseUrl } from "@sandbox-factory/shared";
import type { BuildInfoDto } from "@sandbox-factory/shared";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchApiBuild, webBuild } from "./build";

/**
 * How a link is wrapped for the surface it sits on. The default is the plain
 * one — an anchor is already keyboard-reachable everywhere except inside a
 * Radix menu, which is the case that has to opt in.
 */
export type LinkWrapper = (link: React.ReactNode) => React.ReactElement;

const plainWrapper: LinkWrapper = (link) => <>{link}</>;

/**
 * Asks the API which build it is running, once on mount.
 *
 * Undefined until the answer arrives, and stays undefined if it never does:
 * the readout is about this bundle, and the API's version is only ever used to
 * report a disagreement.
 */
function useApiBuild(): BuildInfoDto | undefined {
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

  return apiBuild;
}

export function BuildReadout({
  wrapLink = plainWrapper,
  className = "",
}: {
  wrapLink?: LinkWrapper;
  className?: string;
}) {
  const apiBuild = useApiBuild();

  const href = commitUrl(webBuild);
  // Only when this build is a release; see `releaseUrl`.
  const release = releaseUrl(webBuild);

  // Only a definite disagreement is shown. No answer, or an unidentified build
  // on either side, is not a mismatch.
  const mismatched =
    apiBuild !== undefined &&
    isIdentified(apiBuild) &&
    isIdentified(webBuild) &&
    apiBuild.gitSha !== webBuild.gitSha;

  return (
    <div className={`text-muted-foreground text-xs tabular-nums ${className}`}>
      <div className="flex items-center justify-center gap-1.5">
        <span className="text-foreground/70 font-medium">
          v{webBuild.version}
        </span>

        {isIdentified(webBuild) &&
          (href === undefined ? (
            <span className="font-mono">{webBuild.gitShortSha}</span>
          ) : (
            wrapLink(
              <a
                className="hover:text-foreground focus-visible:text-foreground font-mono underline decoration-current/30 underline-offset-2 transition-colors"
                href={href}
                target="_blank"
                rel="noreferrer"
                title={buildTitle()}
              >
                {webBuild.gitShortSha}
              </a>,
            )
          ))}

        {/* "dirty" is build-tooling vocabulary, and it is the state every local
            build is in. Said plainly, and only ever seen in development. */}
        {webBuild.dirty && (
          <span
            className="bg-foreground/8 rounded px-1.5 py-0.5 text-[0.68rem] leading-tight"
            title="Built from a working tree with uncommitted changes."
          >
            uncommitted
          </span>
        )}
      </div>

      {release !== undefined &&
        wrapLink(
          <a
            className="hover:text-foreground focus-visible:text-foreground mt-1.5 inline-flex items-center gap-1 underline decoration-current/30 underline-offset-2 transition-colors"
            href={release}
            target="_blank"
            rel="noreferrer"
            title="Release notes and signed artifacts for this version."
          >
            Release notes
            <ExternalLink className="size-3" />
          </a>,
        )}

      {mismatched && (
        <p
          // Amber, not red: a rolling deploy is not a failure and it resolves
          // itself on the next reload. The one thing here that reports
          // something in flight, so the one thing given a colour.
          className="mt-1.5 rounded bg-amber-500/12 px-1.5 py-1 font-mono text-[0.68rem] text-amber-700 dark:text-amber-400"
          title={mismatchTitle(apiBuild)}
        >
          API on {apiBuild.gitShortSha}
        </p>
      )}
    </div>
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
