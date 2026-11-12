# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `apps/web/src/index.ts`. Budget: 40 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `apps/web/src/index.ts` (155 bytes, blob a55ae68442cdbe0741b794127cf9b22cac3dc186)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

The slice imports nothing outside itself.
## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together, with `@acme/shared`, `@payflow/ui`, `zod` declared as untyped packages.
