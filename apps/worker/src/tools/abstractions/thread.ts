/** The compiler thread: `extractTypedSurfaces` on the input it was started with. */

import { parentPort, workerData } from "node:worker_threads";
import { extractTypedSurfaces } from "./typescript.js";
import type { TypedInput } from "./typescript.js";

parentPort?.postMessage(extractTypedSurfaces(workerData as TypedInput));
