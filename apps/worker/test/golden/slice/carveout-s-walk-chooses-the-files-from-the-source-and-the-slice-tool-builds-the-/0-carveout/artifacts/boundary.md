# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/app.ts`. Budget: 40 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `lib/alias.ts` (30 bytes, blob 697b518c2c7a28f9edb746e396c9921107cdb0cf)
- `lib/helpers.ts` (84 bytes, blob 2941dff12dac080e5abe88b8bfc83805b69d8efd)
- `lib/service.ts` (545 bytes, blob b4f7a254f0410af95344e8ae0a0b30e0f5a7d7e7)
- `src/app.ts` (458 bytes, blob 256219cf7290918d0c83767c8a89a2e4d215716d)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `lib/origin.ts`

Imported by: `lib/service.ts`

Stub: `stubs/lib/origin.d.ts`

- **Thing** (interface)

```ts
export interface Thing {
    id: string;
}
```


### `lib/reexport.ts`

Imported by: `src/app.ts`

Stub: `stubs/lib/reexport.d.ts`

- **Thing** (unknown)

```ts
export type { Thing } from "./origin.js";
```


### `lib/types.ts`

Imported by: `lib/service.ts`

Stub: `stubs/lib/types.d.ts`

- **Config** (interface)

```ts
export interface Config {
    name: string;
    nested: Nested;
}
```


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
