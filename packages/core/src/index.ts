/**
 * The domain rules every surface shares: dependency-free, so the same code
 * bundles for the browser and for Node.
 *
 * Public handles are the whole of it today. They are a genuine domain rule
 * rather than a wire concern: users and organizations draw handles from one
 * namespace, so what counts as a valid handle has to be decided in exactly one
 * place, and `packages/shared` refines these rules rather than restating them.
 */

export * from "./handle.js";
export * from "./bounty.js";
