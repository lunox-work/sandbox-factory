import { createService, type ServiceOptions } from "../lib/service.js";
import { fromAlias } from "@lib/alias";
import type { Thing } from "../lib/reexport.js";
import * as helpers from "../lib/helpers.js";
import pg from "pg";

export function run(options: ServiceOptions): Thing {
  const service = createService(options);
  return service.describe(`${helpers.label()}${fromAlias}`);
}

export const client = () => new pg.Client(process.env.DATABASE_URL);
