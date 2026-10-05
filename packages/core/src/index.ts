/**
 * The domain rules every surface shares: dependency-free, so the same code
 * bundles for the browser and for Node.
 *
 * Public handles are a genuine domain rule rather than a wire concern: users
 * and organizations draw handles from one namespace, so what counts as a valid
 * handle has to be decided in exactly one place, and `packages/shared` refines
 * these rules rather than restating them. The commercial rules (`bounty`),
 * what a bounty is and how its text is fingerprinted (`bounty`),
 * the categories that decide which bounties a run offers (`selection`) and
 * the chain that explains a bounty's size (`pricing`) and what a repository's
 * file list says about it (`repo`) live here for the same reason.
 */

export * from "./handle.js";
export * from "./sizing.js";
export * from "./bounty.js";
export * from "./stack.js";
export * from "./selection/index.js";
export * from "./pricing/index.js";
export * from "./repo/index.js";
export * from "./analysis.js";
export * from "./slice/index.js";
export * from "./sandbox/index.js";

export * from "./roles.js";
