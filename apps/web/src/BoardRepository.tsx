/**
 * The repository a board's tickets are about, on the board's own page.
 *
 * Linking one is what lets sizing draft each spec beside an outline of that
 * repository's modules. An owner or admin picks from the organization's
 * registered source repositories; everyone else sees which one is linked,
 * and nothing at all when none is — a board that never used GitHub should
 * not grow a control for it.
 */

import { Check, ChevronDown, FolderGit2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  return (
    <section
      aria-label="Repository"
      data-testid="board-repository"
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
        <span className="text-muted-foreground">Repository</span>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 font-medium"
                disabled={saving || loadError !== null}
              >
                {name}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              {choices.map((repo) => (
                <DropdownMenuItem
                  key={repo.id}
                  onSelect={() => void link(repo.id)}
                  disabled={repo.id === sourceRepoId}
                >
                  <Check
                    className={repo.id === sourceRepoId ? "" : "invisible"}
                  />
                  {repo.fullName}
                </DropdownMenuItem>
              ))}
              {sourceRepoId !== null && (
                <>
                  {choices.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => void link(null)}>
                    <Check className="invisible" />
                    No repository
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="font-medium">{name}</span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {sourceRepoId === null
          ? "Link the repository these tickets are about, and specs are drafted with an outline of its modules."
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
