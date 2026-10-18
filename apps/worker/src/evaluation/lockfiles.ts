/**
 * The lockfiles the local provider keeps between jobs, one per dependency
 * set, so a job whose dependencies were resolved before confirms the tree
 * rather than resolving it again. A kept lockfile is staged into later
 * jobs, whatever organization they build for, and shipped in their
 * sandboxes, so it is trusted only by where it came from and what it says:
 *
 * - Only the worker writes the store, which lives in a directory of its own
 *   that no job's processes can write, and only with a lockfile the job's
 *   trusted preparation step (`npm install --package-lock-only
 *   --ignore-scripts`, resolved online against the public registry with an
 *   empty npm cache of its own, never one an earlier job could write; see
 *   `isLockfilePreparation`) produced before any other command of the job
 *   ran, so no code of the project or its dependencies had run yet.
 * - Whatever is read back, and whatever is written, must fit the manifest
 *   it is for (`lockfileFits`): the root entry asks for exactly what
 *   `package.json` asks for, and every package resolves to its own tarball
 *   on `https://registry.npmjs.org/` (the one its path names) with a
 *   sha512 integrity. Anything else is deleted and the job resolves afresh.
 *
 * Keyed by dependency set, not by organization: the job interface carries
 * no owner, and the content check alone would not make sharing safe, since
 * a lockfile that passes may still pin an older in-range version or any
 * published package as a transitive dependency. Provenance is what makes
 * it safe: what is kept is npm's own resolution of public dependencies,
 * which any organization asking for the same set would have got. A job
 * that stages an `.npmrc` with settings beyond the generated ones (a
 * `before` date, another registry) neither reads nor feeds the store, so
 * it cannot steer that resolution for others. On a worker that cannot
 * switch users the job could write the store directly; the content check
 * is then the only guard, which is one reason that mode is development
 * only.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The manifest fields that decide what is installed. */
const ASKED = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
] as const;
/** Those a lockfile's root entry repeats from the manifest. */
const ROOT_FIELDS = ASKED.filter((field) => field !== "overrides");

const REGISTRY = "https://registry.npmjs.org/";

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * What `package.json` asks to install, hashed: not its name or version,
 * which differ between the versions of one sandbox. Null for one that
 * does not parse.
 */
export function dependencySetKey(packageJson: string): string | null {
  const manifest = parseObject(packageJson);
  if (manifest === null) return null;
  const asked = ASKED.map((field) => [field, manifest[field] ?? null]);
  return createHash("sha256").update(JSON.stringify(asked)).digest("hex");
}

/** Equal as JSON values, with an absent or empty object alike. */
function sameRequests(a: unknown, b: unknown): boolean {
  const normal = (value: unknown) => {
    if (typeof value !== "object" || value === null) return value ?? {};
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([x], [y]) => (x < y ? -1 : x > y ? 1 : 0),
    );
    return Object.fromEntries(entries);
  };
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b));
}

/** A package name as the registry serves it, scoped or not. */
const PACKAGE_NAME =
  /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/**
 * Whether `resolved` is the registry's tarball for `name`: under the
 * name's own path, `<registry><name>/-/<unscoped>-<version>.tgz`, so an
 * entry cannot ship another package's code under its name.
 */
function tarballOf(name: string, resolved: string): boolean {
  if (!PACKAGE_NAME.test(name)) return false;
  const unscoped = name.slice(name.lastIndexOf("/") + 1);
  const prefix = `${REGISTRY}${name}/-/${unscoped}-`;
  return (
    resolved.startsWith(prefix) &&
    /^[^/?#%\\]+\.tgz$/.test(resolved.slice(prefix.length))
  );
}

function fromRegistry(entry: unknown, name: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { resolved, integrity, link } = entry as Record<string, unknown>;
  if (link !== undefined) return false;
  if (typeof resolved !== "string" || typeof integrity !== "string")
    return false;
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return false;
  }
  return (
    url.origin === new URL(REGISTRY).origin &&
    url.username === "" &&
    url.password === "" &&
    tarballOf(name, resolved) &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
  );
}

/** The dependency requests an entry makes, by name. */
function requestsOf(entry: unknown): [string, unknown][] {
  if (typeof entry !== "object" || entry === null) return [];
  return ROOT_FIELDS.flatMap((field) => {
    const asked = (entry as Record<string, unknown>)[field];
    return typeof asked === "object" && asked !== null
      ? Object.entries(asked)
      : [];
  });
}

/**
 * The package an entry installs: the one its path names, or, for an npm
 * alias (`"x": "npm:y@1"`), the `name` it records, but only when some
 * entry asks for `x` as that alias.
 */
function packageOf(
  packages: Record<string, unknown>,
  path: string,
  entry: unknown,
): string | null {
  const name = path.slice(path.lastIndexOf("node_modules/") + 13);
  const recorded =
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>)["name"]
      : undefined;
  if (recorded === undefined || recorded === name) return name;
  if (typeof recorded !== "string") return null;
  const asked = Object.values(packages).some((dependent) =>
    requestsOf(dependent).some(
      ([key, spec]) =>
        key === name &&
        typeof spec === "string" &&
        (spec === `npm:${recorded}` || spec.startsWith(`npm:${recorded}@`)),
    ),
  );
  return asked ? recorded : null;
}

/** `node_modules/a`, `node_modules/@s/b/node_modules/c`, nothing else. */
const PACKAGE_PATH =
  /^node_modules\/(?:@[^/]+\/)?[^/@][^/]*(?:\/node_modules\/(?:@[^/]+\/)?[^/@][^/]*)*$/;

/**
 * Whether a nested entry ships inside the tarball of a package above it
 * that bundles its dependencies: that tarball is itself checked, so the
 * entry needs no source of its own. Never a top-level one.
 */
function bundled(
  packages: Record<string, unknown>,
  path: string,
  entry: unknown,
): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { resolved, inBundle } = entry as Record<string, unknown>;
  if (inBundle !== true || resolved !== undefined) return false;
  let above = path.lastIndexOf("/node_modules/");
  while (above > 0) {
    const ancestor = packages[path.slice(0, above)];
    if (typeof ancestor === "object" && ancestor !== null) {
      const fields = ancestor as Record<string, unknown>;
      const bundles =
        fields["bundleDependencies"] ?? fields["bundledDependencies"];
      if (bundles === true || (Array.isArray(bundles) && bundles.length > 0))
        return true;
    }
    above = path.lastIndexOf("/node_modules/", above - 1);
  }
  return false;
}

/**
 * Lockfile v2's legacy tree, which older npm still reads: each entry at
 * the path it has in `packages`, an alias only where that entry is one.
 */
function legacyFromRegistry(
  packages: Record<string, unknown>,
  dependencies: unknown,
  under = "",
): boolean {
  if (dependencies === undefined) return true;
  if (typeof dependencies !== "object" || dependencies === null) return false;
  return Object.entries(dependencies).every(
    ([key, entry]: [string, unknown]) => {
      const path = `${under}node_modules/${key}`;
      if (typeof entry !== "object" || entry === null) return false;
      const fields = entry as Record<string, unknown>;
      const version = fields["version"];
      // An alias records what it installs as `npm:<name>@<version>`.
      const name =
        typeof version === "string" && version.startsWith("npm:")
          ? version.slice(4, version.lastIndexOf("@"))
          : key;
      if (name !== key && packageOf(packages, path, packages[path]) !== name)
        return false;
      return (
        fromRegistry(entry, name) &&
        legacyFromRegistry(packages, fields["dependencies"], `${path}/`)
      );
    },
  );
}

/**
 * Whether a lockfile is one npm wrote for this manifest from the public
 * registry: version 2 or 3, its root entry asking for exactly what the
 * manifest asks for, and every package the registry tarball of the
 * package its path names (or the alias it was asked for as) with a sha512
 * integrity, or bundled inside one that is. No links, no git or file
 * sources, no other registry.
 */
export function lockfileFits(packageJson: string, lockfile: string): boolean {
  const manifest = parseObject(packageJson);
  const lock = parseObject(lockfile);
  if (manifest === null || lock === null) return false;
  if (lock["lockfileVersion"] !== 2 && lock["lockfileVersion"] !== 3)
    return false;
  const packages = lock["packages"];
  if (typeof packages !== "object" || packages === null) return false;
  const all = packages as Record<string, unknown>;
  const { "": root, ...installed } = all;
  if (typeof root !== "object" || root === null) return false;
  const rootEntry = root as Record<string, unknown>;
  if (
    !ROOT_FIELDS.every((field) =>
      sameRequests(rootEntry[field], manifest[field]),
    )
  )
    return false;
  return (
    Object.entries(installed).every(([path, entry]) => {
      if (
        !PACKAGE_PATH.test(path) ||
        path.split("/").some((part) => part === "." || part === "..")
      )
        return false;
      if (bundled(installed, path, entry)) return true;
      const name = packageOf(all, path, entry);
      return name !== null && fromRegistry(entry, name);
    }) &&
    (lock["lockfileVersion"] === 3 ||
      legacyFromRegistry(all, lock["dependencies"]))
  );
}

/** The settings a generated project's `.npmrc` carries; none move resolution. */
const HARMLESS_NPMRC = new Set([
  "engine-strict",
  "ignore-scripts",
  "fund",
  "audit",
]);

/** Whether a staged `.npmrc` leaves npm resolving as it would without it. */
export function npmrcIsHarmless(text: string): boolean {
  return text.split(/\r?\n/).every((line) => {
    const setting = line.trim();
    if (setting === "" || setting.startsWith("#") || setting.startsWith(";"))
      return true;
    const key = setting.split("=", 1)[0]?.trim() ?? "";
    return HARMLESS_NPMRC.has(key);
  });
}

/**
 * The command that prepares a lockfile without running anything of the
 * project's: the one step whose output may be kept, and which resolves
 * against fresh registry metadata in an empty cache rather than one jobs
 * wrote.
 */
export function isLockfilePreparation(argv: readonly string[]): boolean {
  return (
    argv[0] === "npm" &&
    argv[1] === "install" &&
    argv.includes("--package-lock-only") &&
    argv.includes("--ignore-scripts")
  );
}

export interface LockfileStore {
  /** The kept lockfile for this manifest, if one fits; one that does not goes. */
  get(packageJson: string): Promise<string | null>;
  /** Keeps a lockfile for this manifest when it fits; false when it does not. */
  put(packageJson: string, lockfile: string): Promise<boolean>;
}

export function createLockfileStore(directory: string): LockfileStore {
  const pathOf = (packageJson: string) => {
    const key = dependencySetKey(packageJson);
    return key === null ? null : join(directory, `${key}.json`);
  };
  return {
    async get(packageJson) {
      const path = pathOf(packageJson);
      if (path === null) return null;
      const kept = await readFile(path, "utf8").catch(() => null);
      if (kept === null) return null;
      if (lockfileFits(packageJson, kept)) return kept;
      await rm(path, { force: true });
      return null;
    },
    async put(packageJson, lockfile) {
      const path = pathOf(packageJson);
      if (path === null || !lockfileFits(packageJson, lockfile)) return false;
      // Whole or not at all, so a job never reads half a lockfile.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const partial = `${path}.${randomUUID()}`;
      await writeFile(partial, lockfile, { encoding: "utf8", mode: 0o600 });
      await rename(partial, path);
      return true;
    },
  };
}
