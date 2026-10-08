/**
 * Getting started: the three steps from an empty workspace to a first
 * bounty, with where the workspace is on them.
 *
 * A strip at the head of home rather than a page of its own. The steps are
 * not a wizard to finish before anything works — every stage of home is
 * useful on its own — so they sit above the work, say what is done, and
 * give the one step to take now a button. The rest are named so a person can
 * see what comes after, not offered all at once.
 *
 * Gone once every step is done, and hideable before that, per person and per
 * workspace: someone who means to write bounties by hand has no use for a
 * standing reminder to connect Jira.
 */

import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { setupSteps, type SetupFacts, type SetupStepId } from "./setup";

function hiddenKey(userId: string, organizationId: string): string {
  return `lunox:setup-hidden:${userId}:${organizationId}`;
}

/** Storage can be missing or throw; a miss reads as not hidden. */
export function readSetupHidden(
  userId: string,
  organizationId: string,
): boolean {
  try {
    return (
      window.localStorage.getItem(hiddenKey(userId, organizationId)) === "1"
    );
  } catch {
    return false;
  }
}

function writeSetupHidden(userId: string, organizationId: string): void {
  try {
    window.localStorage.setItem(hiddenKey(userId, organizationId), "1");
  } catch {
    // Hidden for this visit only.
  }
}

/** What each step is called, and what it says in each of its states. */
const COPY: Record<SetupStepId, { title: string; done: string }> = {
  jira: { title: "Find work", done: "Jira connected" },
  github: { title: "Add code", done: "Repository ready" },
  size: { title: "Size a first bounty", done: "Bounty sized" },
};

export interface SetupActions {
  /** Starts Jira's consent. Absent for a member who may not. */
  connectJira?: (() => void) | undefined;
  /** Starts GitHub's install. Absent for a member who may not. */
  connectGithub?: (() => void) | undefined;
  /** Where a first repository is picked, when an account is linked. */
  pickRepository?: (() => void) | undefined;
  /** Where to size: the scan below, or the bounties written by hand. */
  size?: { label: string; onSelect: () => void } | undefined;
}

export function SetupChecklist({
  userId,
  organizationId,
  facts,
  actions,
}: {
  userId: string;
  organizationId: string;
  facts: SetupFacts;
  actions: SetupActions;
}) {
  const [hidden, setHidden] = useState(() =>
    readSetupHidden(userId, organizationId),
  );
  const steps = setupSteps(facts);
  const done = steps.filter((step) => step.done).length;
  if (hidden || steps.length === 0 || done === steps.length) return null;

  /** The control for a step that is the one to take now. */
  function actionFor(id: SetupStepId): ReactNode {
    const ask = (
      <span className="text-muted-foreground text-xs">
        An owner or admin can do this
      </span>
    );
    switch (id) {
      case "jira":
        return actions.connectJira === undefined ? (
          ask
        ) : (
          <Button size="sm" onClick={actions.connectJira}>
            Connect Jira
          </Button>
        );
      case "github":
        if (facts.github.connected > 0 && actions.pickRepository !== undefined)
          return (
            <Button size="sm" onClick={actions.pickRepository}>
              Pick a repository
            </Button>
          );
        return actions.connectGithub === undefined ? (
          ask
        ) : (
          <Button size="sm" onClick={actions.connectGithub}>
            Connect GitHub
          </Button>
        );
      case "size":
        return actions.size === undefined ? (
          ask
        ) : (
          <Button size="sm" onClick={actions.size.onSelect}>
            {actions.size.label}
          </Button>
        );
    }
  }

  /** The line under a step that is neither done nor current. */
  function waiting(id: SetupStepId): string {
    switch (id) {
      case "jira":
        return "Scan the backlog for work to outsource";
      case "github":
        return "Size beside the code, and cut sandboxes from it";
      case "size":
        return "One ticket, about a minute";
    }
  }

  return (
    <section
      aria-label="Getting started"
      data-testid="setup-checklist"
      className="bg-muted/30 rounded-lg border px-4 py-3"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          Getting started
          <span className="text-muted-foreground ml-2 font-normal tabular-nums">
            {done} of {steps.length}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground -mr-2 h-7 gap-1 px-2 text-xs"
          onClick={() => {
            writeSetupHidden(userId, organizationId);
            setHidden(true);
          }}
        >
          <X className="size-3.5" />
          Hide
        </Button>
      </header>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3 sm:gap-4">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.current ? "step" : undefined}
            data-step={step.id}
            data-done={step.done ? "" : undefined}
            className="flex min-w-0 gap-3"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-medium tabular-nums ${
                step.done
                  ? "bg-foreground text-background border-foreground"
                  : step.current
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {step.done ? <Check className="size-3" /> : index + 1}
            </span>
            <span className="flex min-w-0 flex-col items-start gap-1.5">
              <span
                className={`text-sm leading-5 ${step.done ? "text-muted-foreground line-through decoration-1" : "font-medium"}`}
              >
                {COPY[step.id].title}
                <span className="sr-only">
                  {step.done ? " (done)" : step.current ? " (next)" : ""}
                </span>
              </span>
              {step.done ? (
                <span className="text-muted-foreground text-xs">
                  {COPY[step.id].done}
                </span>
              ) : step.current ? (
                actionFor(step.id)
              ) : (
                <span className="text-muted-foreground text-xs">
                  {waiting(step.id)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
