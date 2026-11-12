export declare const API_KEY: string;
export declare const LIMIT: number;
export declare const ENABLED: boolean;
export declare enum Mode {
    Live = "Live",
    Off = "Off"
}
export declare class Client {
    #private;
    send(): string;
    debugDump(): string;
}
export declare class Keys {
    static readonly KEY: string;
    readonly inst: string;
    readonly typed: string;
}
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
export declare const HOSTS: readonly [
    string,
    string
];
export declare const TIER: string;
export declare const BIG: bigint;
