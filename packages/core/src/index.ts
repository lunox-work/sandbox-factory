/**
 * The domain rules every surface shares: dependency-free, so the same code
 * bundles for the browser and for Node.
 *
 * Public handles are a genuine domain rule rather than a wire concern: users
 * and organizations draw handles from one namespace, so what counts as a valid
 * handle has to be decided in exactly one place, and `packages/shared` refines
 * these rules rather than restating them. The commercial rules (`bounty`) and
 * the categories that decide which tickets a run offers (`selection`) live
 * here for the same reason.
 */

export * from "./handle.js";
export * from "./bounty.js";
export * from "./selection/index.js";
