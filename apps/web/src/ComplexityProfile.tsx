import { profileTopic, useObservation } from "./data/observe";
import { usually, useTypicalWaits } from "./data/typical";
import { clients } from "./data/query";
/**
 * A proposal's complexity profile, in the Price tab under the size: the
 * measured evidence its price will point back to, one row per feature, for
 * each repository its sizing said the work touches.
 *
 * Each profile is measured in the background after sizing (a scope agent,
 * then a slice, on the analysis worker), so the hook keeps reading while
 * one is in flight. A proposal that was never profiled shows nothing: its
 * work touched no repository with a snapshot when it was sized.
 */

import type { BountyProfileDto } from "@sandbox-factory/shared";

import type { OrbState } from "@/components/Orb";
import { RuledSection } from "@/components/ReadSection";
import { RunActivity, useRunActivity } from "@/components/RunActivity";

import { plural } from "./lib/format";

/** How often a profile still in flight is read again. */
export const PROFILE_POLL_MS = 10_000;

const IN_FLIGHT = new Set(["queued", "scoping", "slicing"]);

export type ProfileRead =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly retry?: () => void }
  | {
      readonly state: "ready";
      /** One per repository touched, in name order; none when unprofiled. */
      readonly profiles: readonly BountyProfileDto[];
      /** The workspace, whose runs a profile in flight is followed through. */
      readonly owner?: string;
    };

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
    read: (_id, signal) => clients.pricing.profiles(owner, proposalId, signal),
    terminal: (profiles) =>
      profiles.every((profile) => !IN_FLIGHT.has(profile.status)),
    interval: PROFILE_POLL_MS,
    topics: () => [profileTopic(proposalId)],
  });
  if (!drafted) return { state: "ready", profiles: [], owner };
  if (query.isError)
    return {
      state: "failed",
      retry: () => {
        void query.refetch();
      },
    };
  if (query.data === undefined) return { state: "loading" };
  return { state: "ready", profiles: query.data, owner };
}

/**
 * What the orb at the proposal's head does while a profile is measured, so
 * the top of the page says the work below is under way; null once every
 * profile has settled, or before they are read.
 */
export function profileWorking(read: ProfileRead): OrbState | null {
  if (read.state !== "ready") return null;
  const working = read.profiles.find(({ status }) => IN_FLIGHT.has(status));
  return working === undefined ? null : (STAGE_ORB[working.status] ?? null);
}

const STAGE: Record<string, string> = {
  queued: "Waiting for room in the workspace's analysis queue",
  scoping: "The scope agent is choosing the code this spec needs",
  slicing: "Cutting the slice the scope agent chose",
};

/**
 * The orb for each stage: still breathing while it waits for room, sweeping
 * while the scope agent searches the code, morphing while the slice is cut.
 */
const STAGE_ORB: Record<string, OrbState> = {
  queued: "breathing",
  scoping: "searching",
  slicing: "shaping",
};

/** What each stage usually takes, said beside its clock. */
const EXPECTED: Record<string, string> = {
  scoping: "usually 1–2 min",
};

const FAILURE: Record<string, string> = {
  source_unavailable:
    "The repository snapshot or the spec it was sized from is no longer there.",
  scope_failed: "The scope agent could not choose a slice.",
  slice_failed:
    "The slice the scope agent chose could not be sliced from the code.",
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
  flat = false,
}: {
  read: ProfileRead;
  /** The revision the proposal is at, to say when the profile is older. */
  specRevision: number | null | undefined;
  /** Inside its bounty: a ruled section on the page, as the scope's are. */
  flat?: boolean;
}) {
  if (read.state === "loading") return null;
  if (read.state === "failed")
    return (
      <Section flat={flat}>
        <p className="text-muted-foreground text-sm">
          The complexity profile could not be loaded.{" "}
          {read.retry !== undefined && (
            <button
              type="button"
              className="text-primary rounded-sm font-medium hover:underline"
              onClick={read.retry}
            >
              Try again
            </button>
          )}
        </p>
      </Section>
    );
  const [first] = read.profiles;
  if (first === undefined) return null;
  const several = read.profiles.length > 1;
  return (
    <Section flat={flat}>
      {read.profiles.map((stored) =>
        several ? (
          <div key={stored.id} className="mt-2 first:mt-0">
            <p className="mb-1 font-mono text-xs">
              {stored.repository ?? "A removed repository"}
            </p>
            <RepositoryProfile stored={stored} owner={read.owner} />
          </div>
        ) : (
          <RepositoryProfile
            key={stored.id}
            stored={stored}
            owner={read.owner}
          />
        ),
      )}
      {specRevision != null && specRevision !== first.specRevision && (
        <p className="text-muted-foreground mt-2 text-xs">
          Measured for spec revision {first.specRevision}; the spec has changed
          since.
        </p>
      )}
    </Section>
  );
}

/** One repository's profile: where it stands, or what it measured. */
function RepositoryProfile({
  stored,
  owner,
}: {
  stored: BountyProfileDto;
  owner?: string | undefined;
}) {
  const stage = STAGE[stored.status];
  // The run at work, followed for its steps: the scope agent's, then the
  // slice's. None while the profile waits for room.
  const runId =
    stored.status === "scoping"
      ? stored.scopeRunId
      : stored.status === "slicing"
        ? stored.sliceRunId
        : null;
  const run = useRunActivity(owner ?? "", owner === undefined ? null : runId);
  // Asked only while a run is at work, the one time it is said.
  const typical = useTypicalWaits(
    owner ?? "",
    runId === null ? [] : ["run:scope", "run:slice"],
  );
  if (stage !== undefined)
    return (
      <RunActivity
        state={STAGE_ORB[stored.status]}
        progress={run?.progress}
        since={
          run?.startedAt ??
          (stored.status === "queued" ? null : stored.updatedAt)
        }
        expected={usually(
          stored.status === "scoping"
            ? typical.get("run:scope")
            : stored.status === "slicing"
              ? typical.get("run:slice")
              : undefined,
          EXPECTED[stored.status],
        )}
      >
        {stage}
      </RunActivity>
    );
  if (stored.status === "failed" || stored.profile === null)
    return (
      <>
        <p className="text-muted-foreground text-sm" role="status">
          {FAILURE[stored.errorCode ?? ""] ??
            "The complexity profile could not be measured."}
          {stored.runErrorCode !== null && (
            <span className="font-mono"> ({stored.runErrorCode})</span>
          )}
        </p>
      </>
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
    <>
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
      {stored.status === "awaiting_approval" && (
        <p className="text-muted-foreground mt-2 text-xs" role="status">
          The slice the scope agent chose is wider than a sandbox is cut from
          unasked. It is measured and priced as it is; once the price is
          approved, an owner or admin approves the slice on the Sandbox tab
          before a sandbox is cut from it.
        </p>
      )}
    </>
  );
}

function Section({
  flat,
  children,
}: {
  flat: boolean;
  children: React.ReactNode;
}) {
  if (flat)
    return (
      <RuledSection title="Complexity profile" data-testid="proposal-profile">
        <div>{children}</div>
      </RuledSection>
    );
  return (
    <div data-testid="proposal-profile">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        Complexity profile
      </p>
      {children}
    </div>
  );
}
