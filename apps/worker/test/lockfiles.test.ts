import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLockfileStore,
  dependencySetKey,
  isLockfilePreparation,
  lockfileFits,
  npmrcIsHarmless,
} from "../src/evaluation/lockfiles.js";

const MANIFEST = '{"name":"a","dependencies":{"zod":"4.0.0"}}';

/** A lockfile npm would write for `MANIFEST`, with `changes` applied. */
function lockfileFor(
  changes: (lock: {
    lockfileVersion: number;
    packages: Record<string, Record<string, unknown>>;
    dependencies?: unknown;
  }) => void = () => {},
): string {
  const lock = {
    name: "a",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "a", dependencies: { zod: "4.0.0" } } as Record<
        string,
        unknown
      >,
      "node_modules/zod": {
        version: "4.0.0",
        resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
        integrity: "sha512-AbC/+0==",
      } as Record<string, unknown>,
    },
  };
  changes(lock);
  return JSON.stringify(lock);
}

test("a lockfile fits only the manifest it was resolved for, from the public registry", () => {
  assert.equal(lockfileFits(MANIFEST, lockfileFor()), true);
  // Bundled packages come inside a checked tarball that bundles them;
  // version 2 keeps a legacy tree that must hold to the same rule.
  const bundling = (bundles: unknown, path: string) =>
    lockfileFor((lock) => {
      const zod = lock.packages["node_modules/zod"] ?? {};
      zod["bundleDependencies"] = bundles;
      lock.packages[path] = { version: "1.0.0", inBundle: true };
    });
  assert.equal(
    lockfileFits(MANIFEST, bundling(["x"], "node_modules/zod/node_modules/x")),
    true,
  );
  assert.equal(
    lockfileFits(
      MANIFEST,
      bundling(["x"], "node_modules/zod/node_modules/x/node_modules/@s/y"),
    ),
    true,
  );
  // Not at the top, where nothing bundles it, nor under a package that
  // bundles nothing.
  assert.equal(
    lockfileFits(MANIFEST, bundling(["x"], "node_modules/x")),
    false,
  );
  assert.equal(
    lockfileFits(
      MANIFEST,
      bundling(undefined, "node_modules/zod/node_modules/x"),
    ),
    false,
  );
  assert.equal(
    lockfileFits(MANIFEST, bundling([], "node_modules/zod/node_modules/x")),
    false,
  );
  // Each package is its own tarball: scoped ones under their scope, an
  // alias only where it was asked for as one.
  const scoped = '{"dependencies":{"@s/x":"1.0.0"}}';
  const scopedLock = (resolved: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@s/x": "1.0.0" } },
        "node_modules/@s/x": {
          version: "1.0.0",
          resolved,
          integrity: "sha512-AbC=",
        },
      },
    });
  assert.equal(
    lockfileFits(
      scoped,
      scopedLock("https://registry.npmjs.org/@s/x/-/x-1.0.0.tgz"),
    ),
    true,
  );
  for (const resolved of [
    "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
    "https://registry.npmjs.org/@t/x/-/x-1.0.0.tgz",
    "https://registry.npmjs.org/@s/x/-/y-1.0.0.tgz",
    "https://registry.npmjs.org/@s/x/-/x-1.0.0.tgz?evil",
    "https://registry.npmjs.org/@s/x/-/x-1/../../../evil/-/evil-1.0.0.tgz",
  ])
    assert.equal(lockfileFits(scoped, scopedLock(resolved)), false, resolved);
  const aliased = (asked: string, name: unknown) =>
    lockfileFits(
      `{"dependencies":{"zod":"${asked}"}}`,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { zod: asked } },
          "node_modules/zod": {
            name,
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
            integrity: "sha512-AbC=",
          },
        },
      }),
    );
  assert.equal(aliased("npm:evil@1.0.0", "evil"), true);
  assert.equal(aliased("1.0.0", "evil"), false);
  assert.equal(aliased("npm:other@1.0.0", "evil"), false);
  assert.equal(aliased("npm:evil@1.0.0", 3), false);
  const legacy = (dependencies: unknown) =>
    lockfileFor((lock) => {
      lock.lockfileVersion = 2;
      lock.dependencies = dependencies;
    });
  assert.equal(lockfileFits(MANIFEST, legacy(undefined)), true);
  assert.equal(
    lockfileFits(
      MANIFEST,
      legacy({
        zod: {
          version: "4.0.0",
          resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
          integrity: "sha512-AbC=",
          dependencies: {
            y: { resolved: "git+ssh://git@github.com/x/y.git", integrity: "" },
          },
        },
      }),
    ),
    false,
  );
  assert.equal(lockfileFits(MANIFEST, legacy("nope")), false);
  assert.equal(
    lockfileFits(
      MANIFEST,
      legacy({
        zod: {
          version: "4.0.0",
          resolved: "https://registry.npmjs.org/evil/-/evil-4.0.0.tgz",
          integrity: "sha512-AbC=",
        },
      }),
    ),
    false,
  );
  assert.equal(
    lockfileFits(
      MANIFEST,
      legacy({
        zod: {
          version: "npm:evil@4.0.0",
          resolved: "https://registry.npmjs.org/evil/-/evil-4.0.0.tgz",
          integrity: "sha512-AbC=",
        },
      }),
    ),
    false,
  );
  assert.equal(
    lockfileFits(
      '{"dependencies":{"zod":"npm:evil@4.0.0"}}',
      JSON.stringify({
        lockfileVersion: 2,
        packages: {
          "": { dependencies: { zod: "npm:evil@4.0.0" } },
          "node_modules/zod": {
            name: "evil",
            version: "4.0.0",
            resolved: "https://registry.npmjs.org/evil/-/evil-4.0.0.tgz",
            integrity: "sha512-AbC=",
          },
        },
        dependencies: {
          zod: {
            version: "npm:evil@4.0.0",
            resolved: "https://registry.npmjs.org/evil/-/evil-4.0.0.tgz",
            integrity: "sha512-AbC=",
          },
        },
      }),
    ),
    true,
  );

  const refused = [
    lockfileFor((lock) => {
      lock.lockfileVersion = 1;
    }),
    lockfileFor((lock) => {
      lock.packages[""] = { dependencies: { zod: "^4.0.0" } };
    }),
    lockfileFor((lock) => {
      lock.packages[""] = { dependencies: { zod: "4.0.0", evil: "1.0.0" } };
    }),
    lockfileFor((lock) => {
      lock.packages[""] = {
        dependencies: { zod: "4.0.0" },
        devDependencies: { evil: "1.0.0" },
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        resolved: "https://evil.example/zod.tgz",
        integrity: "sha512-AbC=",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        resolved: "https://registry.npmjs.org.evil.example/zod.tgz",
        integrity: "sha512-AbC=",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
        integrity: "sha1-AbC=",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = { resolved: "file:../zod" };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = { link: true, resolved: "zod" };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = { resolved: "not a url" };
    }),
    // Another package's tarball under this one's name.
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
        integrity: "sha512-AbC=",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = {
        name: "evil",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
        integrity: "sha512-AbC=",
      };
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/./zod"] =
        lock.packages["node_modules/zod"] ?? {};
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/x"] = { inBundle: true };
    }),
    lockfileFor((lock) => {
      lock.packages["zod"] = lock.packages["node_modules/zod"] ?? {};
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/../../x"] =
        lock.packages["node_modules/zod"] ?? {};
    }),
    lockfileFor((lock) => {
      lock.packages["node_modules/zod"] = "x" as unknown as Record<
        string,
        unknown
      >;
    }),
    '{"lockfileVersion":3}',
    '{"lockfileVersion":3,"packages":{}}',
    "[]",
    "{",
  ];
  for (const lockfile of refused)
    assert.equal(lockfileFits(MANIFEST, lockfile), false, lockfile);
  assert.equal(lockfileFits("{", lockfileFor()), false);
  // Key order and absent against empty requests do not matter.
  assert.equal(
    lockfileFits(
      '{"dependencies":{"b":"1","a":"2"},"devDependencies":{}}',
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { a: "2", b: "1" } } },
      }),
    ),
    true,
  );
});

test("the dependency set, not the project's name, keys a lockfile", () => {
  assert.equal(
    dependencySetKey(MANIFEST),
    dependencySetKey('{"name":"b","dependencies":{"zod":"4.0.0"}}'),
  );
  assert.notEqual(
    dependencySetKey(MANIFEST),
    dependencySetKey('{"dependencies":{"zod":"4.1.0"}}'),
  );
  assert.equal(dependencySetKey("{"), null);
  assert.equal(dependencySetKey("3"), null);
});

test("only the generated npm settings and the trusted preparation command qualify", () => {
  assert.equal(
    npmrcIsHarmless(
      "engine-strict=true\nignore-scripts=true\nfund=false\naudit=false\n",
    ),
    true,
  );
  assert.equal(npmrcIsHarmless("# note\n; note\n\n"), true);
  assert.equal(npmrcIsHarmless("before=2019-01-01\n"), false);
  assert.equal(npmrcIsHarmless("registry=https://evil.example/"), false);
  assert.equal(
    isLockfilePreparation([
      "npm",
      "install",
      "--package-lock-only",
      "--ignore-scripts",
    ]),
    true,
  );
  assert.equal(
    isLockfilePreparation(["npm", "install", "--package-lock-only"]),
    false,
  );
  assert.equal(isLockfilePreparation(["npm", "ci", "--ignore-scripts"]), false);
  assert.equal(isLockfilePreparation(["node", "x.js"]), false);
});

test("the store keeps only lockfiles that fit, and drops one that no longer does", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "lockfiles-")), "store");
  try {
    const store = createLockfileStore(directory);
    assert.equal(await store.get(MANIFEST), null);
    assert.equal(await store.get("{"), null);
    assert.equal(await store.put("{", lockfileFor()), false);
    assert.equal(await store.put(MANIFEST, "locked"), false);
    assert.equal(await store.put(MANIFEST, lockfileFor()), true);
    assert.equal(await store.get(MANIFEST), lockfileFor());
    // Written there by anyone else, a lockfile that does not fit goes.
    const [name] = await readdir(directory);
    assert.ok(name !== undefined);
    await writeFile(join(directory, name), "poisoned");
    assert.equal(await store.get(MANIFEST), null);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});
