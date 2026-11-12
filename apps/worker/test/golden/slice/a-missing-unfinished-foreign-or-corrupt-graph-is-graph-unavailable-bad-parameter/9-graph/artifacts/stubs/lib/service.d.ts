import type { Config } from "./types.js";
export interface ServiceOptions extends Config {
    retries: number;
}
