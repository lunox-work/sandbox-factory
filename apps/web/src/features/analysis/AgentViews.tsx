/**
 * Reading what an agent run answered, for a run a bounty's flow made.
 *
 * A scope proposal is read from the bounded copy its artifact row carries
 * in `meta`, like the slice boundary, so no browser fetches the private
 * bucket. A fixture set is read the same way. Both are read-only here: the
 * bounty that asked for them is where they are acted on.
 */

import { Badge } from "@/components/ui/badge";
import type { FixtureSetDto, ScopeProposalDto } from "@sandbox-factory/shared";

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

export function ScopeProposalView({
  proposal,
}: {
  proposal: ScopeProposalDto;
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
