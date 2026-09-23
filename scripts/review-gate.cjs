// Executed only from the trusted default branch by review-gate.yml.
// No PR checkout, shell execution, dependency install or PR-supplied code.
const CONTEXT = "Review gate";
const BOT = "coderabbitai[bot]";
const ACTIONS = "github-actions[bot]";
const CHECKS = ["Test (Node 22)", "Test (Node 24)", "Analyze", "CodeQL"];
const MAX_REPAIRS = 3;
const REPAIR_TIMEOUT = 60 * 60 * 1000;
const PREFIX = "<!-- review-gate:repair ";

function isBot(user, login) {
  return user?.login === login && user.type === "Bot";
}

function repairs(comments) {
  return comments.flatMap((comment) => {
    if (!isBot(comment.user, ACTIONS) || !comment.body.startsWith(PREFIX))
      return [];
    try {
      const value = JSON.parse(
        comment.body.slice(PREFIX.length).split(" -->")[0],
      );
      if (
        !/^[a-f0-9]{40}$/.test(value.head) ||
        !["autofix", "fix-ci commit"].includes(value.command)
      )
        return [];
      return [{ ...value, created: Date.parse(comment.created_at) }];
    } catch {
      return [];
    }
  });
}

// Use newest run per expected app/name, never a previous successful rerun.
function checksState(runs) {
  return CHECKS.map((name) => {
    const app =
      name === "CodeQL" ? "github-advanced-security" : "github-actions";
    const run = runs
      .filter((r) => r.name === name && r.app?.slug === app)
      .sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") return "pending";
    return run.conclusion === "success" ? "success" : "failure";
  });
}

function decide(s, now = Date.now()) {
  const pending = (reason) => ({ state: "pending", reason });
  const blocked = (reason) => ({ state: "failure", reason, attention: true });
  if (s.draft) return pending("Draft: mark ready to start review");
  if (!s.trusted) return blocked("Fork: maintainer handling required");
  if (s.conflict)
    return blocked("Merge conflict: maintainer resolution required");
  const last = s.repairs.at(-1);
  if (last?.head === s.head) {
    if (now - last.created >= REPAIR_TIMEOUT)
      return blocked("Repair produced no new commit within one hour");
    return pending("Waiting for requested repair to push a new commit");
  }
  if (s.behind)
    return {
      ...pending("Updating branch with main; checks and review must rerun"),
      update: true,
    };
  if (s.checks.includes("pending"))
    return pending("Waiting for CI and CodeQL on the current head");
  // Failed review infrastructure is not evidence that a review completed.
  if (s.reviewStatus !== "success")
    return pending(
      "Waiting for CodeRabbit to complete the current-head review",
    );
  let command;
  if (s.checks.includes("failure")) command = "fix-ci commit";
  else if (s.rabbitThreads > 0) command = "autofix";
  if (command) {
    if (s.repairs.length >= MAX_REPAIRS)
      return blocked("Three repair rounds exhausted; maintainer help required");
    return {
      ...pending("Requesting CodeRabbit repair; merge remains blocked"),
      command,
    };
  }
  if (s.unresolved > 0) return pending("Unresolved review discussions remain");
  if (s.review?.commit_id !== s.head || s.review?.state !== "APPROVED")
    return pending("Waiting for CodeRabbit approval of this exact head");
  return {
    state: "success",
    reason: "Current head approved; checks pass; no unresolved feedback",
  };
}

async function threads(github, owner, repo, number) {
  const nodes = [];
  let cursor = null;
  do {
    const result = await github.graphql(
      `query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviewThreads(first:100,after:$cursor) {
          nodes { isResolved comments(first:1) { nodes { author { login } } } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      { owner, repo, number, cursor },
    );
    const page = result.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes.filter((t) => !t.isResolved);
}

async function reconcile({ github, context, core, updateToken }) {
  const args = context.repo;
  const base = context.payload.repository?.default_branch || "main";
  const prs = await github.paginate(github.rest.pulls.list, {
    ...args,
    state: "open",
    base,
    per_page: 100,
  });
  for (const item of prs) {
    const pull_number = item.number;
    let head;
    const status = async (state, description) =>
      github.rest.repos.createCommitStatus({
        ...args,
        sha: head,
        context: CONTEXT,
        state,
        description,
        target_url: `https://github.com/${args.owner}/${args.repo}/actions/runs/${context.runId}`,
      });
    try {
      const { data: pr } = await github.rest.pulls.get({
        ...args,
        pull_number,
      });
      if (pr.state !== "open") continue;
      head = pr.head.sha;
      // Revoke a previous success before examining potentially changed discussions.
      await status(
        "pending",
        "Rechecking current-head review and repair state",
      );
      // Commit statuses are shared by SHA, while review/repair evidence is
      // PR-specific. Never let one PR's success unlock another at the same SHA.
      if (prs.filter((p) => p.head.sha === head).length > 1)
        throw new Error("Multiple open PRs share this head SHA");
      const [comments, reviews, runs, statuses, openThreads, comparison] =
        await Promise.all([
          github.paginate(github.rest.issues.listComments, {
            ...args,
            issue_number: pull_number,
            per_page: 100,
          }),
          github.paginate(github.rest.pulls.listReviews, {
            ...args,
            pull_number,
            per_page: 100,
          }),
          github.paginate(github.rest.checks.listForRef, {
            ...args,
            ref: head,
            filter: "latest",
            per_page: 100,
          }),
          github.paginate(github.rest.repos.listCommitStatusesForRef, {
            ...args,
            ref: head,
            per_page: 100,
          }),
          threads(github, args.owner, args.repo, pull_number),
          github.rest.repos.compareCommitsWithBasehead({
            ...args,
            // Compare against the base ref, not pr.base.sha: GitHub freezes
            // base.sha at PR creation, so a branch that fell behind an advancing
            // main would report behind_by 0 and never be updated.
            basehead: `${pr.base.ref}...${head}`,
          }),
        ]);
      const history = repairs(comments);
      const review = reviews
        .filter((r) => isBot(r.user, BOT) && r.state !== "PENDING")
        .sort((a, b) => b.id - a.id)[0];
      const reviewStatus = statuses
        .filter((s) => s.context === "CodeRabbit" && isBot(s.creator, BOT))
        .sort((a, b) => b.id - a.id)[0]?.state;
      const result = decide({
        head,
        draft: pr.draft,
        // A branch in this repository can only be pushed by someone with
        // write access, which is the trust that matters. Not
        // `author_association`: the Actions token does not see a private
        // organization membership, so a member's own PRs read as untrusted.
        trusted: pr.head.repo?.full_name === pr.base.repo.full_name,
        conflict: pr.mergeable === false,
        behind: comparison.data.behind_by > 0,
        repairs: history,
        checks: checksState(runs),
        reviewStatus,
        review,
        unresolved: openThreads.length,
        rabbitThreads: openThreads.filter((t) =>
          [BOT, "coderabbitai"].includes(t.comments.nodes[0]?.author?.login),
        ).length,
      });
      // Events race with bot pushes and closure. Never act on an obsolete snapshot.
      const { data: current } = await github.rest.pulls.get({
        ...args,
        pull_number,
      });
      if (
        current.head.sha !== head ||
        current.state !== "open" ||
        current.draft !== pr.draft
      )
        continue;
      if (result.update) {
        if (!updateToken)
          throw new Error(
            "AUTO_MERGE_TOKEN required to update branch and trigger CI",
          );
        await github.request(
          "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
          {
            ...args,
            pull_number,
            expected_head_sha: head,
            headers: { authorization: `token ${updateToken}` },
          },
        );
      }
      if (result.command) {
        await github.rest.issues.createComment({
          ...args,
          issue_number: pull_number,
          body:
            `${PREFIX}${JSON.stringify({ head, command: result.command })} -->\n` +
            `Repair round ${history.length + 1}/${MAX_REPAIRS} for \`${head}\`.\n\n` +
            `@coderabbitai ${result.command}\n\n` +
            "Fix the underlying issue and add regression coverage. Do not weaken tests, security checks, workflows or review policy. " +
            "If unsafe or unsupported, explain the blocker and leave this PR unmerged. New commits must pass CI and a fresh review.",
        });
      }
      await status(result.state, result.reason);
      if (result.attention) {
        const marker = `<!-- review-gate:attention ${head} -->`;
        if (
          !comments.some(
            (c) => isBot(c.user, ACTIONS) && c.body.startsWith(marker),
          )
        ) {
          await github.rest.issues.createComment({
            ...args,
            issue_number: pull_number,
            body:
              `${marker}\nReview gate blocked: ${result.reason}.\n\n` +
              "Nothing merges until a maintainer resolves it; the gate does not bypass CI, CodeRabbit or the repair limit.",
          });
        }
      }
      core.info(`#${pull_number} ${head}: ${result.reason}`);
    } catch (error) {
      // Do not print API errors that might contain the update token's headers.
      core.setFailed(
        `Review gate failed closed for #${pull_number} (HTTP ${error.status || "unknown"})`,
      );
      if (head)
        await status(
          "failure",
          "Controller error: inspect workflow; no merge permitted",
        );
    }
  }
}

module.exports = {
  CONTEXT,
  CHECKS,
  MAX_REPAIRS,
  REPAIR_TIMEOUT,
  repairs,
  checksState,
  decide,
  threads,
  reconcile,
};
