import type { Config } from "./types.js";
import type { Thing } from "./origin.js";
export interface ServiceOptions extends Config {
    retries: number;
}
export declare class Service {
    #private;
    constructor(options: ServiceOptions);
    describe(label: string): Thing;
}
export declare function createService(options: ServiceOptions): Service;
