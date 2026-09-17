# GitHub Apps and repository setup

What is installed beyond the workflows, and what it takes to reproduce this
setup on a new repository.

## CodeRabbit

The only third-party GitHub App. Installed at the **`lunox-work` organization**
level with `repository_selection: selected`, so adding another repository means
adding it to the existing installation, not installing the app again.

Its `CodeRabbit` check does not gate auto-merge, but **unresolved review
threads do**. [ci.md](./ci.md#branch-protection) is the source of truth for what
blocks a merge.

Behavior is configured in [`.coderabbit.yaml`](../.coderabbit.yaml):

- `profile: chill`, `request_changes_workflow: false` — it comments rather than
  formally requesting changes.
- Auto-review covers non-draft PRs, skipping titles containing `chore(deps)` or
  `release`.
- `path_filters` exclude `dist/`, `dist-test/`, and `package-lock.json`.
- `finishing_touches.autofix` is on: `@coderabbitai autofix` commits to the PR
  branch, `@coderabbitai autofix stacked pr` opens a separate PR. Prefer the
  stacked form for anything non-trivial.
- `chat.auto_reply` is on.

Free on its Open Source plan for public repositories.

## Dependabot

A native GitHub feature, enabled by
[`.github/dependabot.yml`](../.github/dependabot.yml). Nothing to install. See
[ci.md](./ci.md) for its configuration.

## Settings that are not in any file

These will **not** come along if you copy the files into a new repository:

| Setting                   | Current value                 | Where                       |
| ------------------------- | ----------------------------- | --------------------------- |
| Visibility                | Public                        | Settings → General          |
| Default branch            | `main`                        | Settings → Branches         |
| Delete branch on merge    | Enabled                       | Settings → General          |
| Ruleset "main protection" | Active — see [ci.md](./ci.md) | Settings → Rules → Rulesets |
| Classic branch protection | Active — see [ci.md](./ci.md) | Settings → Branches         |
| `AUTO_MERGE_TOKEN` secret | Fine-grained PAT              | Settings → Secrets          |
| Discussions               | **Disabled**                  | Settings → General          |

Visibility matters: CodeQL and Scorecard are gated on the repository being
public, CodeRabbit's free tier requires it, and code scanning upload needs
Advanced Security.

Discussions is off, and
[`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml) does
not link to it. If you enable it later, add the contact link back at the same
time — a link to a disabled tab 404s.

## Labels

Beyond the defaults: `dependencies`, `github_actions`, `javascript` (from
Dependabot); `ci`, `tests`, `source` (labeler); and `accessibility`. The two
`autorelease:` labels are left over from release-please and unused.

The labeler cannot create labels — it holds `pull-requests: write`, not
`issues: write` — so create a label by hand before referencing it in
`labeler.yml`.

## Reproducing this setup

1. Copy the repository contents. Replace `sandbox-factory` with the new name and
   the owner in every URL — `lunox-work` owns the repo, `@feversoul` is the
   maintainer named in `.github/CODEOWNERS`, `package.json`'s `author`, and the
   README copyright.
2. Replace the contact address in `SECURITY.md`.
3. Make the repository public, or expect CodeQL and Scorecard to skip and
   CodeRabbit to need a paid plan.
4. Create the `main protection` ruleset with its required checks, _after_ the
   first CI run so the check names exist to select from. Add the
   `AUTO_MERGE_TOKEN` secret — see [scripts/README.md](../scripts/README.md).
5. Add the repository to the org's CodeRabbit installation.
6. Enable "Automatically delete head branches".
7. Leave Discussions off, or enable it and add a contact link back to
   `.github/ISSUE_TEMPLATE/config.yml`.
8. Decide whether you want npm publishing. Nothing publishes today.
