/**
 * Getting started: the three steps from an empty workspace to a first
 * bounty, with where the workspace is on them.
 *
 * The spine of the onboarding page. The steps are not a wizard to finish
 * before anything works — home is useful at every stage — so they say what
 * is done and give the one step to take now a button. The rest are named so
 * a person can see what comes after, not offered all at once.
 *
 * Drawn as a progress bar of chevrons, each step an arrow pointing at the
 * next: done ones in green, the current one in the brand blue with its
 * button, the rest muted. The chevrons are `index.css`'s, under "getting
 * started"; they turn to point down when the steps stack on a phone.
 *
 * Never hidden: not with a button, not before the first step, not after the
 * last. On a page someone opened to see where setup stands, "all done" is the
 * answer, not an empty space.
 */

import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { setupSteps, type SetupFacts, type SetupStepId } from "./setup";

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
  facts,
  actions,
}: {
  facts: SetupFacts;
  actions: SetupActions;
}) {
  const steps = setupSteps(facts);
  const done = steps.filter((step) => step.done).length;
  if (steps.length === 0) return null;

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
        return "Size beside the code, and slice sandboxes from it";
      case "size":
        return "One ticket, about a minute";
    }
  }

  return (
    <section
      aria-label="Getting started"
      data-testid="setup-checklist"
      className="flex flex-col gap-3"
    >
      <header className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold tracking-tight">
          Getting started
          <span className="text-muted-foreground ml-2 font-normal tabular-nums">
            {done} of {steps.length}
          </span>
        </h2>
        <span
          aria-hidden="true"
          className="bg-muted h-1.5 w-24 overflow-hidden rounded-full sm:w-32"
        >
          <span
            className="setup-meter block h-full rounded-full"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </span>
      </header>
      <ol className="setup-chevrons">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.current ? "step" : undefined}
            data-step={step.id}
            data-done={step.done ? "" : undefined}
            data-state={step.done ? "done" : step.current ? "current" : "todo"}
            className="setup-chevron"
          >
            <span aria-hidden="true" className="setup-chevron-mark">
              {step.done ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : (
                index + 1
              )}
            </span>
            <span className="flex min-w-0 flex-col items-start gap-1.5">
              <span
                className={`text-sm leading-5 ${step.done ? "text-muted-foreground" : "font-semibold tracking-tight"}`}
              >
                {COPY[step.id].title}
                <span className="sr-only">
                  {step.done ? " (done)" : step.current ? " (next)" : ""}
                </span>
              </span>
              {step.done ? (
                <span className="setup-chevron-done text-xs font-medium">
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
