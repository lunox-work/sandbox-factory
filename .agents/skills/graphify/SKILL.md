---
name: graphify
description: Query a local code graph of this repository to find where a symbol is defined, what calls or imports it, and how two modules connect across workspaces. Use before a cross-workspace refactor or when tracing an unfamiliar flow. Navigation aid only.
---

# Graphify (repository maintenance)

A pinned, code-only Graphify graph of this repository, built by
`scripts/graphify.sh` into an external cache. It makes no model calls and
writes nothing into the checkout.

```sh
scripts/graphify.sh refresh                       # build, or update after edits/pulls
scripts/graphify.sh query "<terms>" --budget 1500 # nodes related to the terms
scripts/graphify.sh path "<from>" "<to>"          # how two symbols connect
scripts/graphify.sh explain "<symbol>"            # one node and its neighbours
```

Rules:

- Always go through the script. Do not run `graphify install`, the upstream
  skill, hooks, MCP or semantic extraction: they edit `AGENTS.md`, install
  hooks and may call a model.
- The graph is as fresh as the last `refresh`. Refresh after pulling or after
  edits that move code, before trusting a result.
- Results are leads, not proof. Read the source before changing anything, and
  use `npm run lint:deps` for the enforced import rules.
- Scope is set by `.gitignore` and `.graphifyignore`. SQL and Terraform are not
  parsed.
- This is not the product's Graphify adapter (`apps/worker/src/tools/graphify.ts`,
  pinned separately). Never change that pin for maintenance reasons.

Upstream: `Graphify-Labs/graphify` tag `v0.9.74`
(`e10df08877f8819a625a1afa38c3297a31fda296`), PyPI `graphifyy==0.9.74`. To
upgrade, change `VERSION` in the script and this line together.
