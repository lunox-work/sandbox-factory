# GitHub Apps and repository setup

What is installed on this repository beyond the workflows, and what it takes to
reproduce the setup on a new repository made from this scaffold.

## Installed apps

### CodeRabbit

The only third-party GitHub App installed. It is installed at the
**`lunox-work` organization** level with `repository_selection: selected`, so
adding it to another repository is a matter of adding that repository to the
existing installation rather than installing the app again.

It subscribes to issue, pull request, review, label, release, and repository
events, and posts a review on each PR. Its `CodeRabbit` check reports on pull
requests but is **not** a required status check, so a pending or unhappy review
never blocks a merge.

Behavior is configured in [`.coderabbit.yaml`](../.coderabbit.yaml):

- `profile: chill` and `request_changes_workflow: false` — it comments rather
  than formally requesting changes.
- Auto-review is on for non-draft PRs, but skips titles containing
  `chore(deps)` or `release`. Dependabot PRs are already gated by CI and
  auto-merge, and release PRs are generated; neither benefits from an AI review.
- `path_filters` exclude `dist/`, `dist-test/`, and `package-lock.json` from
  review.
- `finishing_touches.autofix` is enabled. Ask for a fix in a PR comment with
  `@coderabbitai autofix` to commit directly to the PR branch, or
  `@coderabbitai autofix stacked pr` to get a separate PR you can review first.
  Prefer the stacked form for anything non-trivial.
- `chat.auto_reply` is on, so it answers follow-up comments in a thread.

CodeRabbit is free on its Open Source plan for public repositories, which is
part of why this repository is public.

### Dependabot

Not a third-party app — it is a native GitHub feature, enabled by the presence of
[`.github/dependabot.yml`](../.github/dependabot.yml). Nothing to install. See
[ci.md](./ci.md) for what it is configured to do and how auto-merge is gated.

## Repository settings that are not in any file

These are configured through the GitHub UI or API and will **not** come along if
you copy the files into a new repository. Set them deliberately:

| Setting                   | Current value                 | Where                       |
| ------------------------- | ----------------------------- | --------------------------- |
| Visibility                | Public                        | Settings → General          |
| Default branch            | `main`                        | Settings → Branches         |
| Delete branch on merge    | Enabled                       | Settings → General          |
| Ruleset "main protection" | Active — see [ci.md](./ci.md) | Settings → Rules → Rulesets |
| Security policy detected  | Yes, via `SECURITY.md`        | From the file               |
| Discussions               | **Disabled**                  | Settings → General          |

Visibility matters more than it looks: the CodeQL and Scorecard jobs are gated on
the repository being public, CodeRabbit's free tier requires it, and code
scanning upload needs Advanced Security, which is free only for public
repositories.

Discussions is deliberately off, and
[`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml) no
longer links to it — questions go to issues. If you enable Discussions later, add
the contact link back at the same time; a link to a disabled Discussions tab 404s.

## Labels

Beyond GitHub's defaults, the repository has `dependencies`, `github_actions`,
and `javascript` (created by Dependabot), `ci` (used by the labeler),
`accessibility`, and `autorelease: pending` (used by release-please).

The labeler config references `documentation`, `ci`, `dependencies`, `tests`, and
`source`. Of those, **`tests` and `source` do not exist as labels yet** — the
labeler creates missing labels automatically, so this self-corrects on the first
PR touching those paths, but the colors will be arbitrary.

## Reproducing this setup on a new repository

1. Copy the repository contents. Replace `sandbox-factory` with the new name, and
   replace the owner in every repository URL — note the org/user distinction:
   `lunox-work` owns the repo, `@feversoul` is the maintainer named in
   `.github/CODEOWNERS`, `package.json`'s `author`, and the README copyright.
2. Fill in `<CONTACT_EMAIL>` in `SECURITY.md`.
3. Make the repository public, or expect CodeQL and Scorecard to skip and
   CodeRabbit to need a paid plan.
4. Create the `main protection` ruleset with the four required checks. Do this
   _after_ the first CI run, so the check names exist to select from.
5. Add the repository to the org's CodeRabbit installation.
6. Enable "Automatically delete head branches".
7. Leave Discussions off, or enable it and add a contact link back to
   `.github/ISSUE_TEMPLATE/config.yml`. Keep the two in sync either way.
8. Decide whether you want npm publishing. Nothing publishes today.
