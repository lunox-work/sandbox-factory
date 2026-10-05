/**
 * A version's pseudonyms, `private/pseudonym.lunox` in the private sandbox:
 * every alias rule its transform applies, the name as the workspace writes it beside the
 * name contributors read instead.
 *
 * The rules are the version's frozen `aliasRules`, applied in order to the
 * source before it leaves the workspace and inverted, last first, to map a
 * contribution back. A sliced version's rename the repository's code; a
 * generated version's, the names its starter took from the bounty. Private as the hidden tests are: the public
 * sandbox never lists it.
 */

import type { SandboxVersionSourceDto } from "@sandbox-factory/shared";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

type Rule = SandboxVersionSourceDto["aliasRules"][number];

const KIND_LABEL: Record<Rule["kind"], string> = {
  identifier: "Identifier",
  path: "Path",
  text: "Text",
};

/** `3 rules: 2 identifiers, 1 path`, counted by kind in the order of kinds. */
export function pseudonymSummary(rules: readonly Rule[]): string {
  const counts = new Map<Rule["kind"], number>();
  for (const rule of rules)
    counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
  const kinds = (["identifier", "path", "text"] as const)
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      return `${count} ${KIND_LABEL[kind].toLowerCase()}${count === 1 ? "" : "s"}`;
    });
  const total = `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
  return kinds.length === 0 ? total : `${total}: ${kinds.join(", ")}`;
}

export function PseudonymDocument({
  rules,
  generated,
}: {
  rules: readonly Rule[];
  /**
   * Written from the bounty, not cut from a repository. One with none was
   * written before starters had pseudonyms.
   */
  generated: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-16">
      <div className="max-w-5xl">
        <h2 className="text-lg font-semibold text-(--wb-strong)">Pseudonyms</h2>
        <p className="mt-1 max-w-2xl text-(--wb-muted)">
          Each name as the workspace writes it, and the name contributors read
          in the public sandbox instead. Applied in order before the source
          leaves the workspace, and in reverse to map a contribution back.
        </p>
        {rules.length === 0 ? (
          <p
            role="status"
            className="mt-6 rounded-md border border-dashed border-(--wb-input-border) px-4 py-6 text-center text-(--wb-muted)"
          >
            {generated
              ? "No names are aliased. This version's starter was written before starters had pseudonyms; generate it again to give it some."
              : "No names are aliased. Contributors read every name as it is written here."}
          </p>
        ) : (
          <>
            <p className="mt-4 text-xs text-(--wb-muted) tabular-nums">
              {pseudonymSummary(rules)}
            </p>
            <div className="mt-2 overflow-x-auto rounded-md border border-(--wb-border)">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">
                  Private names and the public names they become
                </caption>
                <thead className="bg-(--wb-chrome) text-[11px] tracking-wide text-(--wb-muted) uppercase">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-1.5 font-normal">
                      #
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-normal">
                      Kind
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-normal">
                      Private name
                    </th>
                    <th scope="col" className="w-6 p-0">
                      <span className="sr-only">becomes</span>
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-normal">
                      Public name
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-normal">
                      Scope
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr
                      key={index}
                      className="border-t border-(--wb-border) align-top hover:bg-(--wb-hover)"
                    >
                      <td className="px-3 py-1.5 text-(--wb-gutter) tabular-nums">
                        {index + 1}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-(--wb-muted)">
                        {KIND_LABEL[rule.kind]}
                      </td>
                      <td className="px-3 py-1.5">
                        <Name text={rule.before} side="private" />
                      </td>
                      <td
                        aria-hidden="true"
                        className="p-0 py-1.5 text-(--wb-gutter)"
                      >
                        <ArrowRight className="size-3.5" />
                      </td>
                      <td className="px-3 py-1.5">
                        <Name text={rule.after} side="public" />
                      </td>
                      <td className="px-3 py-1.5 text-(--wb-muted)">
                        {rule.paths.length === 0 ? (
                          "Every file"
                        ) : (
                          <ul>
                            {rule.paths.map((path) => (
                              <li
                                key={path}
                                className="font-(family-name:--wb-font-code) text-xs break-all"
                              >
                                {path}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Name({ text, side }: { text: string; side: "private" | "public" }) {
  return (
    <code
      className={cn(
        "font-(family-name:--wb-font-code) text-xs break-all",
        side === "private" ? "text-(--wb-private)" : "text-(--wb-public)",
      )}
    >
      {text}
    </code>
  );
}
