# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/local.ts`. Budget: 1 files, depth 0.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `src/local.ts` (118 bytes, blob 8709f0a2914c7504f6b7a412850568e492a6e319)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

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


### `src/app.ts`

Imported by: `src/local.ts`

Stub: `stubs/src/app.d.ts`

- **run** (function)

```ts
export declare function run(options: ServiceOptions): Thing;
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together.
