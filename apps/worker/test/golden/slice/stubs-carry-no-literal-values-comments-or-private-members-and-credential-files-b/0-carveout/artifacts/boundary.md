# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `src/app.ts`. Budget: 2 files, depth 1.

Declaration coverage: **full**. Diagnostic only: this slice cannot be published.

## Blockers

- unknown_entry_point: keys/service-account.json names no file in the graph.

## Included files

- `src/app.ts` (322 bytes, blob b0b2dfd01beba1834920188723e1ff5372952a9c)
- `src/w.ts` (53 bytes, blob 06ff0a013f2574e556b054291a9687abc80aa6dd)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `src/b.ts`

Imported by: `src/app.ts`

Stub: `stubs/src/b.d.ts`

- **API_KEY** (variable)

```ts
export declare const API_KEY: string;
```

- **LIMIT** (variable)

```ts
export declare const LIMIT: number;
```

- **ENABLED** (variable)

```ts
export declare const ENABLED: boolean;
```

- **Mode** (enum)

```ts
export declare enum Mode {
    Live = "Live",
    Off = "Off"
}
```

- **Client** (class)

```ts
export declare class Client {
    #private;
    send(): string;
    debugDump(): string;
}
```

- **Keys** (class)

```ts
export declare class Keys {
    static readonly KEY: string;
    readonly inst: string;
    readonly typed: string;
}
```

- **CONFIG** (variable)

```ts
export declare const CONFIG: {
    readonly url: string;
    readonly ports: readonly [
        number,
        number
    ];
    readonly on: boolean;
    readonly nested: {
        readonly region: string;
    };
};
```

- **HOSTS** (variable)

```ts
export declare const HOSTS: readonly [
    string,
    string
];
```

- **TIER** (variable)

```ts
export declare const TIER: string;
```

- **BIG** (variable)

```ts
export declare const BIG: bigint;
```


### `src/u.ts`

Imported by: `src/app.ts`

Stub: `stubs/src/u.d.ts`

- **pick** (function)

```ts
export declare function pick(): number;
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together.
