# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/app.ts`. Budget: 40 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `lib/alias.ts` (30 bytes, blob 697b518c2c7a28f9edb746e396c9921107cdb0cf)
- `lib/helpers.ts` (84 bytes, blob 2941dff12dac080e5abe88b8bfc83805b69d8efd)
- `lib/origin.ts` (41 bytes, blob 088c2a72991aae64980f3396af27947a61c3004a)
- `lib/reexport.ts` (69 bytes, blob e31cdafe0ef1c319aeea2d991f604ad7dc858575)
- `lib/service.ts` (545 bytes, blob b4f7a254f0410af95344e8ae0a0b30e0f5a7d7e7)
- `lib/star.ts` (26 bytes, blob a310e90b46c86d4270c21a8d362573f0cdb630c6)
- `lib/types.ts` (144 bytes, blob 9e707628df4b3add5982fb7f79950e6c7723f9cc)
- `src/app.ts` (458 bytes, blob 256219cf7290918d0c83767c8a89a2e4d215716d)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

The slice imports nothing outside itself.
## Public surface

What outside code imports from the slice; a contribution must keep these.

### `src/app.ts`

Imported by: `consumers/cli.ts`, `src/local.ts`

- **run** (function)

```ts
export declare function run(options: ServiceOptions): Thing;
```


## Externals to mock

- `pg` (postgres) in `src/app.ts`
- `DATABASE_URL` read in `src/app.ts`

## Compilation

The included files and stubs type-check together, with `pg` declared as untyped packages.
