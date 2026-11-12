# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/app.ts`. Budget: 1 files, depth 1.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `src/app.ts` (106 bytes, blob 0c5048ebe9eeffa98f23df00f865c47851c57840)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `src/b.ts`

Imported by: `src/app.ts`

Stub: `stubs/src/b.d.ts`

- **internalHelper** (function)

```ts
export declare function internalHelper(): number;
```

- **make** (function)

```ts
export declare function make(): Hidden;
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together.
