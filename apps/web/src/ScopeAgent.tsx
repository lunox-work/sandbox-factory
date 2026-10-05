import { useQuery } from "@tanstack/react-query";
import { queryKeys, useUserId } from "./data/query";
/**
 * The agent runs in the analysis panel: choosing the proposal an agent
 * works for, and reading what it answered.
 *
 * A scope proposal is read from the bounded copy its artifact row carries
 * in `meta`, like the slice boundary, so no browser fetches the private
 * bucket; "Use this scope" hands its request to the slice picker, where a
 * person reviews it before anything is sliced. A fixture set is read the
 * same way and shown for review before it is attached to a version.
 */

import { Combobox } from "@/components/Combobox";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GithubAnalysisClient } from "@sandbox-factory/client";
import { ApiError } from "@sandbox-factory/client";
import type { FixtureSetDto, ScopeProposalDto } from "@sandbox-factory/shared";
import { useEffect, useState } from "react";

type Usage = ScopeProposalDto["usage"];

function UsageLine({ usage }: { usage: Usage }) {
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;
  return (
    <p className="text-muted-foreground text-xs">
      {usage.model} · {usage.turns} {usage.turns === 1 ? "turn" : "turns"} ·{" "}
      {total.toLocaleString()} tokens ({usage.cacheReadTokens.toLocaleString()}{" "}
      cached)
    </p>
  );
}

/**
 * The proposals of the boards linked to this repository that have a spec,
 * and the action that starts an agent for the chosen one.
 */
export function AgentProposalPicker({
  client,
  organizationId,
  repoId,
  action,
  pending,
  onStart,
  onCancel,
}: {
  client: GithubAnalysisClient;
  organizationId: string;
  repoId: string;
  /** The start button's label. */
  action: string;
  pending: boolean;
  onStart: (proposalId: string) => void;
  onCancel: () => void;
}) {
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(
      userId,
      organizationId,
      "repository-proposals",
      repoId,
    ),
    queryFn: ({ signal }) =>
      client.repositoryProposals(organizationId, repoId, signal),
  });
  const proposals = query.data ?? null;
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    setChosen(query.data?.[0]?.id ?? "");
  }, [query.data]);
  const error =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error.message
        : "Proposals could not be loaded.";
  if (error !== null)
    return <ErrorBanner className="mt-0">{error}</ErrorBanner>;
  if (proposals === null) return <LoadingLine />;
  if (proposals.length === 0)
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          No proposal with a spec is on a board linked to this repository. Link
          a board to it and size a bounty first.
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex max-w-full min-w-0 flex-col gap-1 text-xs">
        Bounty
        <Combobox
          label="Bounty"
          searchPlaceholder="Search bounties…"
          className="w-80 max-w-full"
          contentClassName="w-96"
          options={proposals.map((proposal) => {
            const where = [proposal.status, proposal.boardName].filter(
              (part): part is string => part !== null,
            );
            return {
              value: proposal.id,
              label: [proposal.issueKey, proposal.title ?? "Untitled"]
                .filter((part): part is string => part !== null)
                .join(" · "),
              keywords: where,
              detail: where.join(", "),
            };
          })}
          value={chosen}
          onValueChange={setChosen}
        />
      </div>
      <Button
        size="sm"
        disabled={pending || chosen === ""}
        onClick={() => onStart(chosen)}
      >
        {pending ? "Starting…" : action}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function ScopeProposalView({
  proposal,
  manageable,
  onUse,
}: {
  proposal: ScopeProposalDto;
  manageable: boolean;
  onUse: () => void;
}) {
  const { check } = proposal;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={check.ready ? "default" : "destructive"}>
          {check.ready ? "Slices cleanly" : `${check.blockers} blockers`}
        </Badge>
        <Badge variant="outline">coverage: {check.stubCoverage}</Badge>
        <Badge variant="outline">
          {check.includedFiles} files · {check.outboundModules} cut modules
        </Badge>
        <Badge variant="outline">
          depth {proposal.budget.maxDepth} · up to {proposal.budget.maxFiles}{" "}
          files
        </Badge>
      </div>
      <p className="text-sm">{proposal.summary}</p>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Entry points</h3>
        <ul className="space-y-2">
          {proposal.entryPoints.map((entry) => (
            <li key={entry.path} className="rounded border p-2">
              <p className="font-mono text-xs">{entry.path}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {entry.reason}
              </p>
            </li>
          ))}
        </ul>
        {proposal.includeInferred && (
          <p className="text-muted-foreground text-xs">
            Follows relations the structure analysis inferred.
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Seams</h3>
        {proposal.seams.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The agent named no cut module as a seam.
          </p>
        ) : (
          <ul className="space-y-2">
            {proposal.seams.map((seam) => (
              <li key={seam.module} className="rounded border p-2">
                <p className="font-mono text-xs">
                  {seam.module}{" "}
                  <span className="text-muted-foreground">({seam.kind})</span>
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {seam.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {proposal.risks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Risks</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {proposal.risks.map((risk, index) => (
              <li key={index}>{risk}</li>
            ))}
          </ul>
        </section>
      )}
      <UsageLine usage={proposal.usage} />
      {manageable && (
        <Button size="sm" onClick={onUse}>
          Use this scope
        </Button>
      )}
    </div>
  );
}

export function FixtureSetView({ set }: { set: FixtureSetDto }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">{set.summary}</p>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          Fixtures ({set.fixtures.length})
        </h3>
        {set.fixtures.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Every mocked call keeps returning a recorded mock.
          </p>
        ) : (
          <ul className="space-y-2">
            {set.fixtures.map((fixture) => {
              const target = `${fixture.call === "construct" ? "new " : ""}${fixture.symbol}${fixture.member === null ? "" : `.${fixture.member}`}`;
              return (
                <li
                  key={`${fixture.module}:${target}`}
                  className="rounded border p-2"
                >
                  <p className="font-mono text-xs">
                    {fixture.module} · {target}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {fixture.reason}
                  </p>
                  <pre className="bg-muted mt-2 overflow-auto rounded p-2 text-xs">
                    {fixture.implementation}
                  </pre>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Walkthrough</h3>
        <p className="text-muted-foreground text-xs">
          What <code>npm run dev</code> runs, as sandbox/run.ts.
        </p>
        <pre className="bg-muted max-h-96 overflow-auto rounded p-2 text-xs">
          {set.scenario}
        </pre>
      </section>
      <UsageLine usage={set.usage} />
    </div>
  );
}
