/** The dependency cruise's thread: `cruise` on the options it was started with. */

import { parentPort, workerData } from "node:worker_threads";
import { cruise } from "dependency-cruiser";
import type { ICruiseOptions } from "dependency-cruiser";

const result = await cruise(["."], workerData as ICruiseOptions);
parentPort?.postMessage(
  typeof result.output === "string"
    ? result.output
    : JSON.stringify(result.output),
);
