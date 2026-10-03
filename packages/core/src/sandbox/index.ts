/**
 * Sandbox versions: the private provenance of a task cut from a source
 * repository, the alias table that lets it leave, the approved task it is
 * built for, the runnable project it becomes and the evaluation it runs
 * under. Pure rules and shapes; hashing, files and processes live in the
 * worker and the stores.
 */

export * from "./aliases.js";
export * from "./approved-task.js";
export * from "./provenance.js";
export * from "./build.js";
export * from "./descriptor.js";
export * from "./project.js";
export * from "./fixtures.js";
