/**
 * Whether the signed-in person may link an installation to an organization.
 *
 * `GET /user/installations` proves an installation id is real and near the
 * person, not that it is theirs: GitHub lists every installation that covers
 * a repository they can reach at all. An outside collaborator with read
 * access to one repository of a client's organization sees that
 * organization's installation there, and linking it would let their
 * workspace list and read every private repository it covers.
 *
 * So linking needs more than visibility, without asking the App for any
 * permission beyond Contents and Metadata:
 *
 * - **An installation on a personal account** is theirs only if the account
 *   is theirs — the same GitHub user the grant was made by.
 * - **An installation on an organization** (or an enterprise) is theirs to
 *   link only if they can already read every repository it covers. GitHub's
 *   `GET /user/installations/{id}/repositories` answers with the overlap of
 *   the installation's repositories and the person's own access, so its
 *   count equals the installation's own exactly when the overlap is all of
 *   it. Linking then reveals nothing the person could not already read. An
 *   organization's owner always passes; a collaborator on part of it does
 *   not.
 *
 * The organization check is what can be proved with the permissions the App
 * holds. Proving the person *administers* the organization needs the App to
 * ask for Members: read, and would replace the count here.
 */

import {
  type GithubClient,
  GithubInstallationUnavailable,
  type InstallationTokens,
} from "@sandbox-factory/github";
import type { GithubInstallationResponse } from "@sandbox-factory/shared";

import { installationClient } from "./credential.js";

/**
 * - `yours` — may be linked.
 * - `not-yours` — someone else's account, or repositories the person cannot
 *   read themselves.
 * - `unavailable` — GitHub would not mint a token to count with: suspended,
 *   or uninstalled since the person's list was read.
 */
export type Authority = "yours" | "not-yours" | "unavailable";

export interface Person {
  /** A client over the person's own user-to-server token. */
  readonly client: GithubClient;
  /** Who that token belongs to, as GitHub numbers users. */
  readonly githubUserId: string;
}

export async function authorityOver(
  person: Person,
  installation: GithubInstallationResponse,
  installations: InstallationTokens,
  fetchImpl?: typeof globalThis.fetch,
): Promise<Authority> {
  const account = installation.account;
  if (account?.type === "User") {
    return account.id !== undefined &&
      String(account.id) === person.githubUserId
      ? "yours"
      : "not-yours";
  }

  const installationId = String(installation.id);
  let covered: number;
  try {
    covered = await installationClient(
      installations,
      installationId,
      { kind: "discovery" },
      fetchImpl,
    ).installationRepositoryCount();
  } catch (error) {
    if (error instanceof GithubInstallationUnavailable) return "unavailable";
    throw error;
  }
  const reachable =
    await person.client.userInstallationRepositoryCount(installationId);
  return reachable >= covered ? "yours" : "not-yours";
}
