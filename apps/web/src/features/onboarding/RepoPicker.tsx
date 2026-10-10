/**
 * The first repository, picked where the person already is.
 *
 * Linking a GitHub account gives the platform permission to read the
 * repositories it covers, but nothing is read until one is registered. That
 * used to be a second trip, to the GitHub tab of the workspace's settings;
 * onboarding now opens the same repositories dialog the GitHub tab does, in
 * place. Registering reads the file list and the stack (see `RepoXray`),
 * never the code itself into the platform.
 *
 * One button per linked account, since the dialog is one account's. The
 * page holds the dialog, not this section: registering the first repository
 * ends this step, and the dialog stays open for more until Done.
 */

import type { GithubConnectionDto } from "@sandbox-factory/shared";
import { useId } from "react";

import { ManageRepositoriesButton } from "../../Github";
import { ProviderIcon } from "../../ProviderIcon";
import { SECTION } from "../../lib/reveal";

export function RepoPicker({
  connections,
  canManage,
  onManage,
}: {
  /** The workspace's linked accounts that GitHub still honours. */
  connections: GithubConnectionDto[];
  canManage: boolean;
  /** Opens the repositories dialog for one account. */
  onManage: (connectionId: string) => void;
}) {
  const headingId = useId();
  const [only] = connections;

  return (
    <section
      aria-labelledby={headingId}
      id={SECTION.repoPicker}
      data-testid="repo-picker"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <header>
        <h2 id={headingId} className="text-heading flex items-center gap-2">
          {/* The mark has no size of its own; its box gives it one. */}
          <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">
            <ProviderIcon provider="github" />
          </span>
          Pick the repository your work is in
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Its file list and stack are read to map it — no AI, and its code is
          not copied in. Bounties are then sized beside it, and sandboxes sliced
          from it.
        </p>
      </header>

      {!canManage ? (
        <p className="text-muted-foreground text-xs">
          An owner or admin of this workspace can add one.
        </p>
      ) : connections.length === 1 && only !== undefined ? (
        <ManageRepositoriesButton onClick={() => onManage(only.id)} />
      ) : (
        <ul className="divide-y rounded-md border">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {connection.accountLogin}
              </span>
              <ManageRepositoriesButton
                label={`Manage repositories on ${connection.accountLogin}`}
                onClick={() => onManage(connection.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
