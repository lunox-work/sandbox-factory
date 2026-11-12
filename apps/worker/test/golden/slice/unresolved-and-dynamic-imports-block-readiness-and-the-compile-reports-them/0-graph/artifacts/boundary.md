# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/broken.ts`. Budget: 40 files, depth 3.

Declaration coverage: **partial**. Diagnostic only: this slice cannot be published.

## Blockers

- Declaration coverage is partial.
- compile_error in src/broken.ts: TS2307: Cannot find module './missing.js' or its corresponding type declarations.
- dynamic_dependency in src/broken.ts: A dynamic import of a computed name cannot be resolved.
- missing_build_input in src/broken.ts: unpinned-package is imported but no package.json pins its version.
- unknown_entry_point: nowhere.ts names no file in the graph.
- unresolved_import in src/broken.ts: ./missing.js does not resolve to a repository file.

## Included files

- `src/broken.ts` (198 bytes, blob 668db4178fcb23c350245f4e3c91ccc9925cacc1)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

The slice imports nothing outside itself.
## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

- `src/broken.ts`:1 TS2307: Cannot find module './missing.js' or its corresponding type declarations.
