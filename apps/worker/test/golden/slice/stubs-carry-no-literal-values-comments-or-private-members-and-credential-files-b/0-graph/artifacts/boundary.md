# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `keys/service-account.json`, `src/app.ts`. Budget: 2 files, depth 1.

Declaration coverage: **full**. Diagnostic only: this slice cannot be published.

## Blockers

- secret_file in keys/service-account.json: keys/service-account.json is a credentials file; a slice may not include it. Import fixture values instead.

## Included files

- `keys/service-account.json` (30 bytes, blob f1612dd190e9ccd117465d399cd85ad14f2ef885)
- `src/app.ts` (322 bytes, blob b0b2dfd01beba1834920188723e1ff5372952a9c)

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


### `src/w.ts`

Imported by: `src/app.ts`

Stub: `stubs/src/w.d.ts`

- **one** (variable)

```ts
export declare const one: number;
```

- **two** (function)

```ts
export declare function two(): void;
```


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

No service SDKs or environment reads were detected.

## Compilation

The included files and stubs type-check together.
