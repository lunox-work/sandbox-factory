/**
 * A bounty imported from a GitHub issue: `POST .../bounties` with
 * `{ source: { githubIssue: "https://github.com/owner/repo/issues/N" } }`.
 *
 * - The repository must be one the workspace connected (registered, not
 *   gone), else `repository_not_connected`; the issue is read through the
 *   App's installation, with a token narrowed to that repository and
 *   `issues: read` (`installationClient`'s `issues` scope).
 * - The bounty takes the issue's title, and its body with its labels on a
 *   last line as the description (cut to the bounty's limit, marked
 *   `inputTruncated`). Origin `github`, the issue's URL kept as
 *   `source_url`. Its text is the workspace's from then on: nothing
 *   follows the issue afterwards, unlike a Jira link.
 * - One bounty per issue: importing it again answers the bounty it made
 *   (`created: false`), without reading GitHub.
 * - An issue that does not exist, that the installation cannot see, or
 *   that is a pull request, is `issue_not_found`.
 */

import type {
  BountyStore,
  GithubRepoSummary,
  StoredBounty,
} from "@sandbox-factory/db";
import { GithubNotFound } from "@sandbox-factory/github";
import {
  GITHUB_ISSUE_URL,
  type GithubIssueResponse,
  type ImportGithubIssueInput,
} from "@sandbox-factory/shared";
import { BOUNTY_LIMITS, clampBountyTitle } from "sandbox-factory";

import { connectedRepositories } from "./held-context.js";

export interface GithubIssueSource {
  readonly repos: {
    list(organizationId: string): Promise<readonly GithubRepoSummary[]>;
  };
  /**
   * A client that reads one repository's issues, or null when its
   * installation cannot be used now (the connection needs reconnecting).
   */
  readonly issuesFor: (
    organizationId: string,
    repo: GithubRepoSummary,
  ) => Promise<{
    issue(fullName: string, number: number): Promise<GithubIssueResponse>;
  } | null>;
}

export type GithubIssueImport =
  | {
      readonly ok: true;
      readonly bounty: StoredBounty;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422 | 502;
      readonly code: string;
      readonly error: string;
    };

const TRUNCATED = "\n\n[truncated]";

/** The issue's text as a bounty's description, cut to fit. */
export function issueDescription(issue: GithubIssueResponse): {
  description: string;
  truncated: boolean;
} {
  const labels = issue.labels.map((label) =>
    typeof label === "string" ? label : label.name,
  );
  const body = (issue.body ?? "").trim();
  const text = [
    body,
    labels.length === 0 ? "" : `GitHub labels: ${labels.join(", ")}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  if (text.length <= BOUNTY_LIMITS.description)
    return { description: text, truncated: false };
  let cut = text.slice(0, BOUNTY_LIMITS.description - TRUNCATED.length);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { description: `${cut}${TRUNCATED}`, truncated: true };
}

export async function importGithubIssue(
  source: GithubIssueSource,
  bounties: Pick<BountyStore, "create" | "findBySource">,
  organizationId: string,
  userId: string,
  input: ImportGithubIssueInput,
): Promise<GithubIssueImport> {
  const [, owner = "", name = "", number = "0"] =
    GITHUB_ISSUE_URL.exec(input.source.githubIssue) ?? [];
  const wanted = `${owner}/${name}`.toLowerCase();
  const repo = (await connectedRepositories(source.repos, organizationId)).find(
    ({ fullName }) => fullName.toLowerCase() === wanted,
  );
  if (repo === undefined)
    return {
      ok: false,
      status: 422,
      code: "repository_not_connected",
      error: `${owner}/${name} is not a repository this workspace connected.`,
    };
  const url = `https://github.com/${repo.fullName}/issues/${number}`;
  const existing = await bounties.findBySource(organizationId, url);
  if (existing !== null) return { ok: true, bounty: existing, created: false };

  const client = await source.issuesFor(organizationId, repo);
  if (client === null)
    return {
      ok: false,
      status: 409,
      code: "reconnect",
      error: "This repository's GitHub connection needs reconnecting.",
    };
  let issue: GithubIssueResponse;
  try {
    issue = await client.issue(repo.fullName, Number(number));
  } catch (error) {
    if (error instanceof GithubNotFound) return notFound(url);
    return {
      ok: false,
      status: 502,
      code: "github_unavailable",
      error: "GitHub did not give the issue. Try again shortly.",
    };
  }
  if (issue.pull_request !== undefined && issue.pull_request !== null)
    return notFound(url, "is a pull request, not an issue");

  const { description, truncated } = issueDescription(issue);
  const title = clampBountyTitle(issue.title.trim()) || `Issue #${number}`;
  try {
    const bounty = await bounties.create(organizationId, userId, {
      title,
      description,
      stack: input.stack,
      source: { origin: "github", url },
      inputTruncated: truncated,
    });
    return { ok: true, bounty, created: true };
  } catch (error) {
    // Imported by another request meanwhile: answer that one.
    const raced = await bounties.findBySource(organizationId, url);
    if (raced !== null) return { ok: true, bounty: raced, created: false };
    throw error;
  }
}

function notFound(url: string, why = "was not found"): GithubIssueImport {
  return {
    ok: false,
    status: 404,
    code: "issue_not_found",
    error: `${url} ${why}.`,
  };
}
