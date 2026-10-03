/**
 * The slice a task needs, as a pure function of a snapshot's graph: which
 * files, where the cuts fall, what sits outside, and the shapes of the
 * records a slice run writes. Reading source, extracting signatures and
 * hashing bytes happen in the worker; nothing here touches a file.
 */

export * from "./graph.js";
export * from "./reach.js";
export * from "./externals.js";
export * from "./manifest.js";
export * from "./scope.js";
