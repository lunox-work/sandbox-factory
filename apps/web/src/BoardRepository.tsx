/**
 * The repository a board's tickets are about, on the board's own page.
 *
 * Linking one is what lets sizing draft each spec beside an outline of that
 * repository's modules. An owner or admin picks from the organization's
 * registered source repositories; everyone else sees which one is linked,
 * and nothing at all when none is — a board that never used GitHub should
 * not grow a control for it.
 *
 * A workspace with exactly one repository and a board linked to none is
 * almost always a board about that repository, so it is offered as one
 * click, said as what it buys, rather than as a picker with one entry.
 */

import { FolderGit2, Link2, Loader2 } from "lucide-react";
import { useState } from "react";

import { Combobox } from "@/components/Combobox";
import { Button } from "@/components/ui/button";

import { SECTION } from "./lib/reveal";
import { useGithubRepos } from "./useGithub";

export function BoardRepository({
  organizationId,
  sourceRepoId,
  canManage,
  onLink,
}: {
  organizationId: string;
  /** The linked repository, or null. */
  sourceRepoId: string | null;
  canManage: boolean;
  /** Saves the link; resolves to null when saved, else what to say. */
  onLink: (repoId: string | null) => Promise<string | null>;
}) {
  const { repos, loading, error: loadError } = useGithubRepos(organizationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = repos.find((repo) => repo.id === sourceRepoId) ?? null;
  // A repository GitHub no longer shows us cannot be newly picked, though
  // one already linked stays named.
  const choices = repos.filter(
    (repo) => repo.role === "source" && repo.syncStatus !== "gone",
  );

  if (loading) return null;
  if (
    sourceRepoId === null &&
    (!canManage || (choices.length === 0 && loadError === null))
  ) {
    return null;
  }

  const name =
    linked?.fullName ??
    (loadError !== null
      ? "Repository unavailable"
      : sourceRepoId === null
        ? "No repository"
        : "A removed repository");

  async function link(repoId: string | null) {
    setSaving(true);
    setError(null);
    const failure = await onLink(repoId);
    setSaving(false);
    setError(failure);
  }

  const only = choices.length === 1 ? choices[0] : undefined;
  if (canManage && sourceRepoId === null && only !== undefined) {
    return (
      <section
        aria-label="Repository"
        id={SECTION.boardRepository}
        data-testid="board-repository"
        className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5"
      >
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
        <p className="min-w-0 flex-1 text-sm">
          Size this board beside{" "}
          <span className="font-medium">{only.fullName}</span>
          <span className="text-muted-foreground">
            {" "}
            — specs are drafted with its modules in view, and sandboxes cut from
            its code.
          </span>
        </p>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          disabled={saving}
          onClick={() => void link(only.id)}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Link2 />}
          Link repository
        </Button>
        {error !== null && (
          <p className="text-destructive w-full text-xs" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Repository"
      id={SECTION.boardRepository}
      data-testid="board-repository"
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
        <span className="text-muted-foreground">Repository</span>
        {canManage ? (
          <Combobox
            label="Repository"
            searchPlaceholder="Search repositories…"
            emptyMessage="No repository matches."
            className="h-8 w-auto max-w-full font-medium"
            contentClassName="w-72"
            options={[
              ...choices.map((repo) => ({
                value: repo.id,
                label: repo.fullName,
              })),
              ...(sourceRepoId === null
                ? []
                : [{ value: "", label: "No repository" }]),
            ]}
            value={sourceRepoId ?? ""}
            // Names a linked repository the list no longer offers, too.
            placeholder={name}
            disabled={saving || loadError !== null}
            onValueChange={(repoId) => void link(repoId === "" ? null : repoId)}
          />
        ) : (
          <span className="font-medium">{name}</span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {sourceRepoId === null
          ? "Link the repository these bounties are about, and specs are drafted with an outline of its modules."
          : "Specs are drafted with an outline of this repository's modules, from its newest snapshot."}
      </p>
      {(error ?? loadError) !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error ?? loadError}
        </p>
      )}
    </section>
  );
}
