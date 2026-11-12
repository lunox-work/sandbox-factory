# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `apps/svc/src/main.ts`. Budget: 40 files, depth 3.

Declaration coverage: **full**. No blockers: the slice may proceed to the sandbox gates.

## Included files

- `apps/svc/src/main.ts` (204 bytes, blob 39e1f93dd6d69a6f135c6324f264addf066ddd38)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `packages/shared/src/index.ts`

Imported by: `apps/svc/src/main.ts`

Stub: `stubs/packages/shared/src/index.d.ts`

- **boxed** (variable)

```ts
export declare const boxed: import("kit").Box<{
    id: string;
}>;
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together.

Checked against the published types of `kit@1.2.3`.
