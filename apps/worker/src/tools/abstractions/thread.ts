/**
 * The compiler thread: `extractTypedSurfaces` on the input it was started
 * with. Posts `{ done }` as it reads modules, then `{ result }`.
 */

import { parentPort, workerData } from "node:worker_threads";
import { extractTypedSurfaces } from "./typescript.js";
import type { TypedInput } from "./typescript.js";

parentPort?.postMessage({
  result: extractTypedSurfaces(workerData as TypedInput, (done) =>
    parentPort?.postMessage({ done }),
  ),
});
