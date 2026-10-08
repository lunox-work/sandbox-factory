/**
 * The first repository, picked where the person already is.
 *
 * Linking a GitHub account gives the platform permission to read the
 * repositories it covers, but nothing is read until one is registered. That
 * used to be a second trip, to the GitHub tab of the workspace's settings;
 * home now offers the account's repositories in place, so the step after
 * connecting is one click. Registering reads the file list and the stack
 * (see `RepoXray`), never the code itself into the platform.
 *
 * Every linked account's repositories, unregistered first: one already
 * registered is listed as such, since it is not one to pick again.
 */

import type {
  GithubConnectionDto,
  GithubInstallationRepositoryDto,
} from "@sandbox-factory/shared";
import { useQueries } from "@tanstack/react-query";
import { Loader2, Lock, Search } from "lucide-react";
import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import { ProviderIcon } from "../../ProviderIcon";
import { clients, queryKeys, useUserId } from "../../data/query";
import { SECTION } from "../../lib/reveal";

/** Rows before the list asks for a search instead. */
const VISIBLE = 6;

export function RepoPicker({
  organizationId,
  connections,
  canManage,
  register,
}: {
  organizationId: string;
  /** The workspace's linked accounts that GitHub still honours. */
  connections: GithubConnectionDto[];
  canManage: boolean;
  /** Registers one; resolves to null when done, or to what to say. */
  register: (
    connectionId: string,
    externalId: string,
  ) => Promise<string | null>;
}) {
  const userId = useUserId();
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reads = useQueries({
    queries: connections.map((connection) => ({
      // The same read the GitHub tab makes for this account.
      queryKey: queryKeys.resource(
        userId,
        organizationId,
        "github-installation-repositories",
        connection.id,
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        clients.github.installationRepositories(
          organizationId,
          connection.id,
          signal,
        ),
    })),
  });
  const loading = reads.some((read) => read.isPending);
  const failed = reads.some((read) => read.isError);
  const rows: {
    connection: GithubConnectionDto;
    repository: GithubInstallationRepositoryDto;
  }[] = reads.flatMap((read, index) => {
    const connection = connections[index];
    return connection === undefined
      ? []
      : (read.data ?? []).map((repository) => ({ connection, repository }));
  });
  const needle = query.trim().toLowerCase();
  const matching = rows
    .filter(({ repository }) =>
      repository.fullName.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        Number(a.repository.registeredId !== null) -
          Number(b.repository.registeredId !== null) ||
        a.repository.fullName.localeCompare(b.repository.fullName),
    );

  async function pick(connectionId: string, externalId: string) {
    setPending(externalId);
    setMessage(null);
    const failure = await register(connectionId, externalId);
    setPending(null);
    setMessage(failure);
  }

  return (
    <section
      aria-labelledby={headingId}
      id={SECTION.repoPicker}
      data-testid="repo-picker"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <header>
        <h2
          id={headingId}
          className="flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          {/* The mark has no size of its own; its box gives it one. */}
          <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">
            <ProviderIcon provider="github" />
          </span>
          Pick the repository your work is in
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Its file list and stack are read to map it — no AI, and its code is
          not copied in. Bounties are then sized beside it, and sandboxes cut
          from it.
        </p>
      </header>

      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Reading what GitHub lets this workspace see…
        </p>
      ) : failed && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Could not list this account&rsquo;s repositories.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          The App can see no repositories yet. Choose some in its settings on
          GitHub, then come back.
        </p>
      ) : (
        <>
          {rows.length > VISIBLE && (
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                type="search"
                aria-label="Search repositories"
                placeholder="Search repositories…"
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}
          <ul className="divide-y rounded-md border">
            {matching.slice(0, VISIBLE).map(({ connection, repository }) => (
              <li
                key={`${connection.id}:${repository.externalId}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                  <span className="truncate">{repository.fullName}</span>
                  {repository.isPrivate && (
                    <Lock
                      aria-label="Private"
                      className="text-muted-foreground size-3 shrink-0"
                    />
                  )}
                </span>
                {repository.registeredId !== null ? (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    Added
                  </span>
                ) : canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={pending !== null}
                    aria-label={`Use ${repository.fullName}`}
                    onClick={() =>
                      void pick(connection.id, repository.externalId)
                    }
                  >
                    {pending === repository.externalId && (
                      <Loader2 className="animate-spin" />
                    )}
                    Use
                  </Button>
                ) : null}
              </li>
            ))}
            {matching.length === 0 && (
              <li className="text-muted-foreground px-3 py-2 text-sm">
                No repository matches.
              </li>
            )}
          </ul>
          {!canManage && (
            <p className="text-muted-foreground text-xs">
              An owner or admin of this workspace can add one.
            </p>
          )}
        </>
      )}
      {message !== null && (
        <p className="text-destructive text-xs" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
