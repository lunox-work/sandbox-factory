import { useObservation } from "./data/observe";
import { clients } from "./data/query";
/**
 * A proposal's complexity profile, in the Bounty tab under the size: the
 * measured evidence its price will point back to, one row per feature.
 *
 * The profile is measured in the background after sizing (a scope agent,
 * then a slice, on the analysis worker), so the hook keeps reading while it
 * is in flight. A proposal that was never profiled shows nothing: neither
 * its ticket nor its board named a repository when it was sized.
 */

import type { BountyProfileDto } from "@sandbox-factory/shared";

import { LoadingLine } from "@/components/Message";

import { plural } from "./ProposalSpec";

/** How often a profile still in flight is read again. */
export const PROFILE_POLL_MS = 10_000;

const IN_FLIGHT = new Set(["queued", "scoping", "slicing"]);

export type ProfileRead =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly retry?: () => void }
  | { readonly state: "ready"; readonly profile: BountyProfileDto | null };

export function useProposalProfile(
  base: string,
  proposalId: string,
  /** The proposal's spec revision: a re-price that moves it reads again. */
  specRevision: number | null | undefined,
  /**
   * Whether the proposal has a spec. Only a spec is ever profiled, so
   * nothing is asked for a proposal without one. Not whether the spec was
   * drafted beside a snapshot: pruning the snapshot clears the proposal's
   * link to it, while the profile it measured stays.
   */
  drafted: boolean,
): ProfileRead {
  const owner = decodeURIComponent(base.split("/").at(-1) ?? "");
  const query = useObservation({
    owner,
    resource: "profile",
    id: drafted ? `${proposalId}:${specRevision ?? ""}` : null,
    read: (_id, signal) => clients.pricing.profile(owner, proposalId, signal),
    terminal: (profile) => profile === null || !IN_FLIGHT.has(profile.status),
    interval: PROFILE_POLL_MS,
  });
  if (!drafted) return { state: "ready", profile: null };
  if (query.isError)
    return {
      state: "failed",
      retry: () => {
        void query.refetch();
      },
    };
  if (query.data === undefined) return { state: "loading" };
  return { state: "ready", profile: query.data };
}

const STAGE: Record<string, string> = {
  queued: "Waiting for room in the workspace's analysis queue.",
  scoping: "The scope agent is choosing the code this spec needs.",
  slicing: "Cutting the slice the scope agent chose.",
};

const FAILURE: Record<string, string> = {
  source_unavailable:
    "The repository snapshot or the spec it was sized from is no longer there.",
  scope_failed: "The scope agent could not choose a slice.",
  slice_failed: "The slice the scope agent chose could not be cut.",
  output_invalid: "An analysis finished, but its result could not be read.",
};

function size(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
}

/** A list of names after a count, or nothing when there are none. */
function named(names: readonly string[]): string {
  return names.length === 0 ? "" : `: ${names.join(", ")}`;
}

export function ComplexityProfileBlock({
  read,
  specRevision,
}: {
  read: ProfileRead;
  /** The revision the proposal is at, to say when the profile is older. */
  specRevision: number | null | undefined;
}) {
  if (read.state === "loading") return null;
  if (read.state === "failed")
    return (
      <Section>
        <p className="text-muted-foreground text-sm">
          The complexity profile could not be loaded.
          {read.retry !== undefined && (
            <button onClick={read.retry}>Try again</button>
          )}
        </p>
      </Section>
    );
  const stored = read.profile;
  if (stored === null) return null;

  const stage = STAGE[stored.status];
  if (stage !== undefined)
    return (
      <Section>
        <LoadingLine>{stage}</LoadingLine>
      </Section>
    );
  if (stored.status === "failed" || stored.profile === null)
    return (
      <Section>
        <p className="text-muted-foreground text-sm" role="status">
          {FAILURE[stored.errorCode ?? ""] ??
            "The complexity profile could not be measured."}
          {stored.runErrorCode !== null && (
            <span className="font-mono"> ({stored.runErrorCode})</span>
          )}
        </p>
      </Section>
    );

  const profile = stored.profile;
  const { slice, externals, spec, tests, nonFunctional } = profile;
  const demands = [
    nonFunctional.scenarios > 0 &&
      plural(nonFunctional.scenarios, "non-functional scenario"),
    nonFunctional.migrations && "migrations in a touched module",
    nonFunctional.ci && "CI configured",
  ].filter((demand): demand is string => typeof demand === "string");
  const rows: [string, React.ReactNode][] = [
    [
      "Ticket",
      `${profile.ticket.issueType}${
        profile.ticket.priority === null
          ? ""
          : `, priority ${profile.ticket.priority}`
      }`,
    ],
    [
      "Slice",
      `${plural(slice.files, "file")} in ${plural(
        slice.modules.length,
        "module",
      )}, ${size(slice.bytes)}${
        slice.blockers > 0 ? `, ${plural(slice.blockers, "blocker")}` : ""
      }`,
    ],
    [
      "Modules touched",
      `${profile.touchedModules.length}${named(profile.touchedModules)}`,
    ],
    [
      "External services",
      [
        `${externals.services.length}${named(externals.services)}`,
        externals.environment > 0 &&
          plural(externals.environment, "environment variable"),
        externals.seams > 0 && plural(externals.seams, "mocked seam"),
      ]
        .filter(Boolean)
        .join("; "),
    ],
    [
      "Spec clarity",
      `${plural(spec.openQuestions, "open question")}, ${plural(
        spec.assumptions,
        "assumption",
      )}`,
    ],
    [
      "Tests on the path",
      tests.files === 0
        ? "None in the touched modules"
        : `${plural(tests.files, "test file")}${
            tests.untestedModules.length > 0
              ? `; none in ${tests.untestedModules.join(", ")}`
              : ""
          }`,
    ],
    [
      "Analogous pattern",
      profile.pattern === null ? (
        "None found"
      ) : (
        <>
          <span className="font-mono">{profile.pattern.path}</span>
          {` — ${profile.pattern.reason}`}
        </>
      ),
    ],
    ["Non-functional", demands.length === 0 ? "None" : demands.join(", ")],
  ];

  return (
    <Section>
      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
        data-testid="profile-rows"
      >
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 leading-relaxed break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {profile.risks.length > 0 && (
        <ul className="text-muted-foreground mt-2 list-disc pl-5 text-xs">
          {profile.risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      )}
      {specRevision != null && specRevision !== stored.specRevision && (
        <p className="text-muted-foreground mt-2 text-xs">
          Measured for spec revision {stored.specRevision}; the spec has changed
          since.
        </p>
      )}
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="proposal-profile">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        Complexity profile
      </p>
      {children}
    </div>
  );
}
