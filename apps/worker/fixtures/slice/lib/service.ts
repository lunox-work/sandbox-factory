import type { Config } from "./types.js";
import type { Thing } from "./origin.js";

export interface ServiceOptions extends Config {
  retries: number;
}

export class Service {
  constructor(private readonly options: ServiceOptions) {}
  describe(label: string): Thing {
    return { id: `${label}:${this.options.name}:${this.secret()}` };
  }
  private secret(): number {
    return this.options.retries * 2;
  }
}

export function createService(options: ServiceOptions): Service {
  return new Service(options);
}

export const unused = 42;
