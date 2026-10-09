import { ApiError } from "@sandbox-factory/client";
import {
  activeRunConflictSchema,
  type BountyRunDto,
} from "@sandbox-factory/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { clients } from "../../data/query";
import { terminalRun, useObservation } from "../../data/observe";

/**
 * Where a re-analysis stands: none, one at work (`queued` while it waits
 * for room), or one that ended without a new proposal, and why.
 */
export type ReanalyzeState =
  | { phase: "idle" }
  | {
      phase: "working";
      queued: boolean;
      /** The run as last read, with what it has made so far. */
      run: BountyRunDto | undefined;
    }
  | { phase: "ended"; line: string };

/** Why a re-price ended with the proposal as it was. */
function reanalyzeFailure(run: BountyRunDto): string | null {
  const outcome = run.outcomes[0];
  if (
    run.status !== "failed" &&
    outcome !== undefined &&
    outcome.status !== "failed" &&
    outcome.status !== "skipped"
  )
    return null;
  switch (outcome?.code ?? run.fatalErrorCode) {
    case "sizing_failed":
    case "spec_failed":
      return "The model could not analyze this bounty, so the proposal is as it was. Try again.";
    case "proposal_changed":
      return "The proposal changed while it was analyzed, so nothing was replaced. Try again.";
    case "writeback_busy":
      return "Resolve the Jira update before re-analyzing.";
    case "reconnect":
      return "This bounty's Jira site needs reconnecting before it can be read.";
    default:
      return "The re-analysis could not finish, so the proposal is as it was. Try again.";
  }
}

/**
 * Asks the model to analyze a proposal again and follows the run to its
 * end, so the page can set the old analysis aside while it works and show
 * the new one as it lands.
 *
 * `activeRun` is the change the proposal's own read says is rewriting it:
 * a re-price there is followed as if this page had started it, so a reload
 * mid-run still shows the run at work. `onLanded` reads the proposal again
 * before the page leaves its working state, so the new price replaces the
 * placeholder rather than the old one flashing back first.
 */
export function useReanalyze(
  base: string,
  proposalId: string,
  revision: number,
  activeRun: BountyRunDto | null | undefined,
  onLanded: () => Promise<void> | void,
) {
  const owner = decodeURIComponent(base.split("/").at(-1) ?? "");
  // Between the click and the run's id: working, before the server answers.
  const [requesting, setRequesting] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const landed = useRef(onLanded);
  useEffect(() => {
    landed.current = onLanded;
  }, [onLanded]);
  // Runs already seen to their end, so a read still naming one does not
  // start following it again.
  const completed = useRef(new Set<string>());

  // Another proposal: what was said about the last one goes with it.
  useEffect(() => {
    setRequesting(false);
    setFollowing(null);
    setEnded(null);
  }, [base, proposalId]);

  const adopt =
    activeRun?.kind === "reprice" && !completed.current.has(activeRun.id)
      ? activeRun.id
      : null;
  useEffect(() => {
    if (adopt === null) return;
    setEnded(null);
    setFollowing((current) => current ?? adopt);
  }, [adopt]);

  const observed = useObservation({
    owner,
    resource: "bounty-run",
    id: following,
    interval: 1_000,
    startDelay: 1_000,
    terminal: terminalRun,
    read: (id, signal) => clients.runs.run(owner, id, signal),
  });
  useEffect(() => {
    const run = observed.data;
    if (
      following === null ||
      run === undefined ||
      run.id !== following ||
      !terminalRun(run) ||
      completed.current.has(run.id)
    )
      return;
    completed.current.add(run.id);
    // A run in the way that was not this proposal's: the board's own.
    const line =
      run.kind !== "reprice" || run.sourceProposalId !== proposalId
        ? "Another sizing run on this board was under way. It has finished: re-analyze again."
        : reanalyzeFailure(run);
    const done = () => {
      setFollowing((current) => (current === run.id ? null : current));
      setEnded(line);
    };
    void Promise.resolve(landed.current()).then(done, done);
  }, [following, observed.data, proposalId]);
  useEffect(() => {
    if (!observed.isError || following === null) return;
    setFollowing(null);
    setEnded("Lost track of the re-analysis. Reload to see where it stands.");
  }, [observed.isError, following]);

  const start = useCallback(() => {
    setRequesting(true);
    setEnded(null);
    void (async () => {
      try {
        const body = await clients.pricing.action(
          owner,
          `/proposals/${encodeURIComponent(proposalId)}/reprice`,
          { expectedRevision: revision, requestId: crypto.randomUUID() },
        );
        if (body.run !== undefined) setFollowing(body.run.id);
        else setEnded("The re-analysis could not be started. Try again.");
      } catch (error) {
        const conflict =
          error instanceof ApiError
            ? activeRunConflictSchema.safeParse(error.details)
            : null;
        // Already under way: wait for that one instead.
        if (conflict?.success) setFollowing(conflict.data.runId);
        else
          setEnded(
            error instanceof ApiError
              ? error.message
              : "Could not reach the server.",
          );
      } finally {
        setRequesting(false);
      }
    })();
  }, [owner, proposalId, revision]);

  // The run as last read: the poll's, or until it answers, the proposal's.
  const run =
    observed.data?.id === following
      ? observed.data
      : activeRun?.id === following
        ? activeRun
        : undefined;
  const state: ReanalyzeState =
    requesting || following !== null
      ? { phase: "working", queued: run?.status === "queued", run }
      : ended !== null
        ? { phase: "ended", line: ended }
        : { phase: "idle" };
  return { state, start };
}
