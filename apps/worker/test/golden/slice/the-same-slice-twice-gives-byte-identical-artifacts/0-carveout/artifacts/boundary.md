# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/app.ts`. Budget: 1 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `src/app.ts` (458 bytes, blob 256219cf7290918d0c83767c8a89a2e4d215716d)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `lib/alias.ts`

Imported by: `src/app.ts`

Stub: `stubs/lib/alias.d.ts`

- **fromAlias** (variable)

```ts
export declare const fromAlias: string;
```


### `lib/helpers.ts`

Imported by: `src/app.ts`

Stub: `stubs/lib/helpers.d.ts`

- **label** (function)

```ts
export declare function label(): string;
```


### `lib/origin.ts`

Imported by: `lib/reexport.ts`

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


### `lib/service.ts`

Imported by: `src/app.ts`

Stub: `stubs/lib/service.d.ts`

- **ServiceOptions** (interface)

```ts
export interface ServiceOptions extends Config {
    retries: number;
}
```

- **createService** (function)

```ts
export declare function createService(options: ServiceOptions): Service;
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
