# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `apps/svc/src/main.ts`. Budget: 40 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `apps/svc/src/main.ts` (338 bytes, blob 79cd102341b4822ccdf49a5fc50030d0ed272153)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `packages/core/src/index.ts`

Imported by: `apps/svc/src/main.ts`, `packages/shared/src/wrapped.ts`

Stub: `stubs/packages/core/src/index.d.ts`

- **Core** (interface)

```ts
export interface Core {
    readonly n: number;
}
```

- **make** (function)

```ts
export declare function make(): Core;
```


### `packages/shared/src/index.ts`

Imported by: `apps/svc/src/main.ts`

Stub: `stubs/packages/shared/src/index.d.ts`


### `packages/shared/src/schemas.ts`

Imported by: `packages/shared/src/index.ts`

Stub: `stubs/packages/shared/src/schemas.d.ts`

- **itemSchema** (variable)

```ts
export declare const itemSchema: any;
```


### `packages/shared/src/wrapped.ts`

Imported by: `packages/shared/src/index.ts`

Stub: `stubs/packages/shared/src/wrapped.d.ts`

- **Wrapped** (interface)

```ts
export interface Wrapped {
    readonly core: Core;
}
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together, with `zod` declared as untyped packages.

2 more errors the source has too, with its packages untyped, are not counted; the sandbox build checks them against the packages it installs.
