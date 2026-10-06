import { ApiError } from "@sandbox-factory/client";
import { activeRunConflictSchema } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { terminalRun, useObservation } from "./data/observe";
import { clients, queryKeys, useUserId } from "./data/query";
/**
 * Changing a proposal's spec from its Scenarios tab: more scenarios of a
 * kind, scenarios for an instruction, answers to the open questions, or a
 * scenario taken out. And reading the revisions those changes made.
 *
 * Every change is a run on the server, as a re-price is: it is asked for,
 * followed until it ends, and then the proposal is read again, since its
 * size may have moved. What the change did is said in one line where it
 * was asked for: "S → S+: +4 points", or why nothing changed.
 */

import type {
  BountyRunDto,
  BountySpecRevisionDto,
  RespecRequestDto,
} from "@sandbox-factory/shared";
import { ChevronDown, Loader2, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  RESPEC_LIMITS,
  SCENARIO_KIND_DEFINITIONS,
  type ScenarioKind,
} from "sandbox-factory";

import { Combobox } from "@/components/Combobox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Where a change stands, as the tab shows it. */
export type RespecState =
  | { readonly phase: "idle" }
  | { readonly phase: "working"; readonly label: string }
  /** It landed: the size it moved from, and the points it moved the spec by. */
  | {
      readonly phase: "landed";
      readonly previous: string;
      readonly pointsDelta: number;
    }
  /** It ended without a change, or failed: why, in a sentence. */
  | {
      readonly phase: "ended";
      readonly tone: "note" | "error";
      readonly line: string;
    };

export interface RespecControl {
  readonly state: RespecState;
  /** Asks for a change; `label` is what the tab says while it runs. */
  readonly request: (change: RespecRequestDto, label: string) => void;
}

/** Why a run ended without an outcome, by its fatal code. */
const RUN_FAILURES: Readonly<Record<string, string>> = {
  reconnect: "Reconnect Jira, then try again.",
  scope: "Jira refused the read. Connect the site again to grant it.",
  proposal_changed:
    "The proposal changed before the change could start. Try again.",
  board_unavailable: "The board is no longer connected.",
  worker_lost: "The change was interrupted. Try again.",
};

/** What a change's outcome says when it did not land, by its code. */
const OUTCOME_LINES: Readonly<Record<string, string>> = {
  nothing_added: "Nothing new to add: the spec already covers that.",
  proposal_stale:
    "The bounty changed since it was sized. Re-analyze it before changing its scenarios.",
  proposal_changed:
    "The proposal changed while this ran, so nothing was saved. Try again.",
  spec_failed: "The model's answer could not be used. Try again.",
  issue_unavailable: "Jira no longer has this bounty.",
  jira_rate_limited: "Jira is busy. Try again in a minute.",
};

/** What a finished run did, as the tab says it. */
export function respecResult(run: BountyRunDto): RespecState {
  const outcome = run.outcomes[0];
  if (outcome === undefined) {
    const code = run.fatalErrorCode ?? "";
    return {
      phase: "ended",
      tone: "error",
      line: code.startsWith("sizing_")
        ? "The model could not be reached. Try again later."
        : (RUN_FAILURES[code] ?? "The change could not be made. Try again."),
    };
  }
  if (
    outcome.status === "proposed" &&
    outcome.previousComplexity !== undefined
  ) {
    return {
      phase: "landed",
      previous: outcome.previousComplexity,
      pointsDelta: outcome.pointsDelta ?? 0,
    };
  }
  return {
    phase: "ended",
    tone: outcome.code === "nothing_added" ? "note" : "error",
    line:
      OUTCOME_LINES[outcome.code ?? ""] ??
      "The change could not be made. Try again.",
  };
}

/**
 * Asks for changes to one proposal's spec and follows each to its end.
 *
 * `onLanded` is how the proposal is read again once a change has ended,
 * before the tab says what it did, so the line and the size beside it
 * agree. A change refused because another is running follows that one
 * instead, since its result is the one the reader is waiting on.
 *
 * `activeRun` is the change the proposal's own read says is rewriting it;
 * a spec change there is followed too, so a reload mid-change still says
 * the change is at work rather than offering a second.
 */
export function useRespec(
  base: string,
  proposalId: string,
  revision: number,
  onLanded: () => Promise<void> | void,
  activeRun?: BountyRunDto | null,
): RespecControl {
  const [state, setState] = useState<RespecState>({ phase: "idle" });
  const [following, setFollowing] = useState<string | null>(null);
  const landed = useRef(onLanded);
  useEffect(() => {
    landed.current = onLanded;
  }, [onLanded]);
  // The last change seen to its end, so a read still naming it is not
  // followed again.
  const completed = useRef<string | null>(null);

  // Another proposal: what was said about the last one goes with it.
  useEffect(() => {
    setState({ phase: "idle" });
    setFollowing(null);
  }, [base, proposalId, revision]);
  const adopt =
    activeRun?.kind === "respec" && completed.current !== activeRun.id
      ? activeRun.id
      : null;
  useEffect(() => {
    if (adopt === null || following !== null) return;
    setState({ phase: "working", label: "Changing the scenarios…" });
    setFollowing(adopt);
  }, [adopt, following]);

  const selection = `${base}:${proposalId}:${revision}`;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const observed = useObservation({
    owner: decodeURIComponent(base.split("/").at(-1) ?? ""),
    resource: "bounty-run",
    id: following,
    interval: 1_000,
    startDelay: 1_000,
    terminal: terminalRun,
    read: (id, signal) =>
      clients.runs.run(
        decodeURIComponent(base.split("/").at(-1) ?? ""),
        id,
        signal,
      ),
  });
  useEffect(() => {
    const run = observed.data;
    if (
      following === null ||
      run === undefined ||
      !terminalRun(run) ||
      completed.current === run.id
    )
      return;
    completed.current = run.id;
    const selected = selection;
    setFollowing(null);
    void Promise.resolve(landed.current()).then(() => {
      if (selectionRef.current === selected) setState(respecResult(run));
    });
  }, [following, observed.data, selection]);
  useEffect(() => {
    if (observed.isError)
      setState({
        phase: "ended",
        tone: "error",
        line: "Lost track of the spec change. Try again.",
      });
  }, [observed.isError]);

  const request = useCallback(
    (change: RespecRequestDto, label: string) => {
      setState({ phase: "working", label });
      const selected = selection;
      void (async () => {
        try {
          const body = await clients.pricing.action(
            decodeURIComponent(base.split("/").at(-1) ?? ""),
            `/proposals/${encodeURIComponent(proposalId)}/respec`,
            {
              expectedRevision: revision,
              requestId: crypto.randomUUID(),
              request: change,
            },
          );
          if (selectionRef.current !== selected) return;
          if (body.run !== undefined) {
            setFollowing(body.run.id);
            return;
          }
          setState({
            phase: "ended",
            tone: "error",
            line: "The scenarios could not be changed.",
          });
        } catch (error) {
          if (selectionRef.current !== selected) return;
          const conflict =
            error instanceof ApiError
              ? activeRunConflictSchema.safeParse(error.details)
              : null;
          if (conflict?.success) {
            setState({
              phase: "working",
              label: "Waiting for the change already under way…",
            });
            setFollowing(conflict.data.runId);
            return;
          }
          setState({
            phase: "ended",
            tone: "error",
            line:
              error instanceof ApiError
                ? error.message
                : "Could not reach the server.",
          });
        }
      })();
    },
    [base, proposalId, revision, selection],
  );

  return { state, request };
}

/** "+4 points", "−1 point": signed, with a true minus. */
function signedPoints(delta: number): string {
  const size = Math.abs(delta);
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${sign}${size} point${size === 1 ? "" : "s"}`;
}

/**
 * The line under the controls: the change at work, what it did to the
 * size, or why it did nothing. `size` is the proposal's size now, which a
 * landed change is read against.
 */
export function RespecStatus({
  state,
  size,
}: {
  state: RespecState;
  size: string;
}) {
  if (state.phase === "idle") return null;
  if (state.phase === "working") {
    return (
      <p
        role="status"
        data-testid="respec-status"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        {state.label}
      </p>
    );
  }
  if (state.phase === "landed") {
    const moved = state.previous !== size;
    return (
      <p role="status" data-testid="respec-status" className="text-sm">
        <span className="font-mono font-medium">
          {moved ? `${state.previous} → ${size}` : `Still ${size}`}
        </span>
        : {signedPoints(state.pointsDelta)}
      </p>
    );
  }
  return (
    <p
      role={state.tone === "error" ? "alert" : "status"}
      data-testid="respec-status"
      className={`text-sm ${
        state.tone === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {state.line}
    </p>
  );
}

/** A kind as a menu item and a working line read it. */
const KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  SCENARIO_KIND_DEFINITIONS.map(({ id, label }) => [id, label]),
);

/** What the tab says while scenarios of a kind are written. */
export function expandLabel(kind: ScenarioKind): string {
  return `Writing more ${(KIND_LABEL[kind] ?? kind).toLowerCase()} scenarios…`;
}

/**
 * The ways to grow the spec: more of any kind, scenarios for an
 * instruction, or answers to its open questions. Every kind is listed, so
 * "generate more" needs no second menu.
 */
export function ExpandMenu({
  disabled,
  canAnswer,
  onKind,
  onAnswer,
  onInstruction,
}: {
  disabled: boolean;
  /** Whether the spec has open questions to answer. */
  canAnswer: boolean;
  onKind: (kind: ScenarioKind) => void;
  onAnswer: () => void;
  onInstruction: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <Plus />
          Add scenarios
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-muted-foreground flex items-center gap-1.5 text-xs font-normal">
          <Sparkles aria-hidden="true" className="size-3.5" />
          Generate more
        </DropdownMenuLabel>
        {SCENARIO_KIND_DEFINITIONS.map(({ id, label, covers }) => (
          <DropdownMenuItem key={id} title={covers} onSelect={() => onKind(id)}>
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canAnswer} onSelect={onAnswer}>
          Answer open questions…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInstruction}>
          Describe what to add…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const textareaClass =
  "placeholder:text-muted-foreground border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50";

/**
 * The spec's open questions, each with a field for its answer. Any number
 * may be answered at once, since a bounty's questions usually come as a
 * handful; the blank ones are left open.
 */
export function AnswerForm({
  questions,
  disabled,
  onSubmit,
  onCancel,
}: {
  questions: readonly string[];
  disabled: boolean;
  onSubmit: (answers: { question: string; answer: string }[]) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const id = useId();
  const given = questions.flatMap((question, index) => {
    const answer = (answers[index] ?? "").trim();
    return answer === "" ? [] : [{ question, answer }];
  });
  return (
    <form
      aria-label="Answer open questions"
      className="bg-muted/40 flex flex-col gap-3 rounded-md p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (given.length > 0) onSubmit(given);
      }}
    >
      {questions.map((question, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-${index}`} className="text-sm">
            {question}
          </label>
          <textarea
            id={`${id}-${index}`}
            className={textareaClass}
            rows={2}
            maxLength={RESPEC_LIMITS.answerChars}
            placeholder="Leave blank to keep it open"
            value={answers[index] ?? ""}
            disabled={disabled}
            onChange={(event) =>
              setAnswers((current) => ({
                ...current,
                [index]: event.target.value,
              }))
            }
          />
        </div>
      ))}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={disabled || given.length === 0}
        >
          {given.length > 1
            ? `Revise for ${given.length} answers`
            : "Revise for this answer"}
        </Button>
      </div>
    </form>
  );
}

/** A free instruction for the scenarios to add. */
export function InstructionForm({
  disabled,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const id = useId();
  const trimmed = instruction.trim();
  return (
    <form
      aria-label="Describe what to add"
      className="bg-muted/40 flex flex-col gap-2 rounded-md p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "") onSubmit(trimmed);
      }}
    >
      <label htmlFor={id} className="text-sm">
        What should the new scenarios cover?
      </label>
      <textarea
        id={id}
        className={textareaClass}
        rows={3}
        maxLength={RESPEC_LIMITS.instructionChars}
        placeholder="A recruiter on a phone, an invitation sent twice…"
        value={instruction}
        disabled={disabled}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled || trimmed === ""}>
          Add scenarios
        </Button>
      </div>
    </form>
  );
}

/**
 * Every revision a proposal's spec has had, read when there is more than
 * one: a pointer at revision 1 has no history to pick from.
 */
export function useSpecRevisions(
  base: string,
  proposalId: string,
  specRevision: number | null,
): readonly BountySpecRevisionDto[] {
  const owner = decodeURIComponent(base.split("/").at(-1) ?? "");
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(
      userId,
      owner,
      "proposal-spec-revisions",
      proposalId,
      specRevision,
    ),
    enabled: specRevision !== null && specRevision > 1,
    queryFn: ({ signal }) =>
      clients.pricing.revisions(owner, proposalId, signal),
  });
  return query.data ?? [];
}

/** How a revision came to be, as the picker names it. */
const ORIGIN_NAME: Readonly<Record<string, string>> = {
  draft: "drafted",
  expand: "expanded",
  answer: "answered",
  trim: "trimmed",
};

/**
 * Which revision of the spec is on show. The current one is the one the
 * size goes with; an earlier one is read-only.
 */
export function RevisionPicker({
  revisions,
  viewing,
  onView,
}: {
  revisions: readonly BountySpecRevisionDto[];
  viewing: number;
  onView: (revision: number) => void;
}) {
  // Lower case: it reads on from the counts before it.
  const options = revisions.map(({ revision, origin, current }) => ({
    value: String(revision),
    label: `revision ${revision}, ${ORIGIN_NAME[origin] ?? origin}${current ? " (current)" : ""}`,
  }));
  const shown = options.find(({ value }) => value === String(viewing));
  return (
    <Combobox
      label="Revision"
      searchPlaceholder="Search revisions…"
      contentClassName="w-60"
      options={options}
      value={String(viewing)}
      onValueChange={(next) => onView(Number(next))}
      trigger={
        // Text in a line of text, not a field: it reads as part of the line.
        <button
          type="button"
          role="combobox"
          aria-label="Revision"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:text-foreground -my-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-sm align-baseline text-xs outline-none focus-visible:ring-[3px]"
        >
          {shown?.label ?? `revision ${viewing}`}
          <ChevronDown aria-hidden="true" className="size-3 self-center" />
        </button>
      }
    />
  );
}

/** A revision's origin as the header menu names it. */
function originName(origin: string): string {
  const name = ORIGIN_NAME[origin] ?? origin;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Which revision of the spec is on show, in the header over the decision,
 * as a sandbox chooses its version: the revision, chosen from the others
 * when there are several. While the current one is shown the trigger reads
 * `label`, such as the proposal's version, so the header names one number;
 * an earlier one is named as the revision it is.
 */
export function RevisionMenu({
  revisions,
  current,
  viewing,
  label,
  onView,
}: {
  revisions: readonly BountySpecRevisionDto[];
  /** The revision the proposal points at. */
  current: number;
  viewing: number;
  /** What the current revision is called; its revision number otherwise. */
  label?: string;
  onView: (revision: number) => void;
}) {
  const text =
    viewing === current && label !== undefined ? label : `Revision ${viewing}`;
  const name = <span className="font-semibold">{text}</span>;
  if (revisions.length <= 1) return name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-ring/50 -mx-1 flex w-fit cursor-pointer items-center gap-1 rounded-sm px-1 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
          aria-label={`${text}, choose another revision`}
        >
          {name}
          <ChevronDown className="text-muted-foreground size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {revisions.map(({ revision, origin }) => (
          <DropdownMenuItem
            key={revision}
            onSelect={() => onView(revision)}
            className="justify-between gap-4"
          >
            <span>Revision {revision}</span>
            <span className="text-muted-foreground text-xs">
              {revision === current ? "Current" : originName(origin)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
