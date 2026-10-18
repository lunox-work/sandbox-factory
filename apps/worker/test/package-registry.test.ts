import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  isPublicRegistry,
  packageRegistries,
} from "../src/tools/package-registry.js";

async function repository(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "package-registry-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const npmjs = (name: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop() ?? ""}-1.0.0.tgz`;

test("the public registry is npm's, and Yarn's alias of it", () => {
  assert.equal(isPublicRegistry("https://registry.npmjs.org"), true);
  assert.equal(isPublicRegistry(npmjs("zod")), true);
  assert.equal(
    isPublicRegistry("https://registry.yarnpkg.com/zod/-/zod-1.0.0.tgz"),
    true,
  );
  assert.equal(isPublicRegistry("https://registry.npmjs.org.acme.io/"), false);
  assert.equal(isPublicRegistry("https://npm.acme.io/"), false);
  assert.equal(isPublicRegistry("git+ssh://git@example.test/x.git"), false);
});

test("a package-lock entry resolved from the public registry is evidence; any other is not", async () => {
  const root = await repository({
    "package-lock.json": {
      lockfileVersion: 3,
      packages: {
        "": { name: "acme-monorepo" },
        "node_modules/zod": { resolved: npmjs("zod") },
        "apps/web/node_modules/react": { resolved: npmjs("react") },
        "node_modules/@acme/ui": {
          resolved: "https://npm.acme.io/@acme/ui/-/ui-1.0.0.tgz",
        },
        "node_modules/@acme/shared": { link: true, resolved: "packages/x" },
        "node_modules/acme-utils": { version: "1.0.0" },
      },
      dependencies: {
        lodash: {
          resolved: npmjs("lodash"),
          dependencies: {
            "acme-internal": { resolved: "https://npm.acme.io/x.tgz" },
          },
        },
      },
    },
  });
  try {
    const of = packageRegistries(root);
    assert.deepEqual(of("zod"), {
      source: "public",
      evidence: "package-lock.json",
    });
    assert.equal(of("react")?.source, "public");
    assert.equal(of("lodash")?.source, "public");
    assert.deepEqual(of("@acme/ui"), {
      source: "private",
      evidence: "package-lock.json",
    });
    assert.equal(of("acme-internal")?.source, "private");
    // A link is the repository's own; no URL is no evidence.
    assert.equal(of("@acme/shared"), null);
    assert.equal(of("acme-utils"), null);
    assert.equal(of("left-pad"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm, Yarn and publish configuration that send a scope elsewhere make it private", async () => {
  const root = await repository({
    ".npmrc": [
      "; comment",
      "# comment",
      "@acme:registry=https://npm.acme.io/",
      "@open:registry=https://registry.npmjs.org/",
      "//npm.acme.io/:_authToken=${TOKEN}",
      "no-equals",
    ].join("\n"),
    ".yarnrc": '"@payflow:registry" "https://npm.payflow.dev"\n',
    ".yarnrc.yml": [
      "# Berry",
      "nodeLinker: node-modules",
      "npmScopes:",
      "  ledger:",
      '    npmRegistryServer: "https://npm.ledger.dev"',
      "  '@open':",
      "    npmAlwaysAuth: true",
      "",
    ].join("\n"),
    "package.json": {
      name: "@globex/root",
      workspaces: ["packages/*"],
      publishConfig: { registry: "https://npm.globex.dev", access: 1 },
    },
    "packages/ui/package.json": {
      name: "ui",
      publishConfig: { "@initech:registry": "https://npm.initech.dev" },
    },
    "package-lock.json": {
      packages: {
        "node_modules/@acme/ui": { resolved: npmjs("@acme/ui") },
        "node_modules/@open/kit": { resolved: npmjs("@open/kit") },
      },
    },
  });
  try {
    const of = packageRegistries(root);
    // The configuration outweighs a lockfile's public URL.
    assert.deepEqual(of("@acme/ui"), { source: "private", evidence: ".npmrc" });
    assert.deepEqual(of("@open/kit"), {
      source: "public",
      evidence: "package-lock.json",
    });
    assert.deepEqual(of("@payflow/sdk"), {
      source: "private",
      evidence: ".yarnrc",
    });
    assert.deepEqual(of("@ledger/core"), {
      source: "private",
      evidence: ".yarnrc.yml",
    });
    assert.deepEqual(of("@globex/types"), {
      source: "private",
      evidence: "package.json",
    });
    assert.deepEqual(of("@initech/x"), {
      source: "private",
      evidence: "packages/ui/package.json",
    });
    assert.equal(of("zod"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a default registry elsewhere makes every package private", async () => {
  const root = await repository({
    ".yarnrc.yml": 'npmRegistryServer: "https://proxy.acme.io"\n',
    "yarn.lock": `zod@^4.0.0:\n  version "4.0.0"\n  resolved "${npmjs("zod")}#abc"\n`,
  });
  try {
    assert.deepEqual(packageRegistries(root)("zod"), {
      source: "private",
      evidence: ".yarnrc.yml",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("yarn.lock: classic resolved URLs, and Berry resolutions from a registry the repository names", async () => {
  const classic = await repository({
    "yarn.lock": [
      "# yarn lockfile v1",
      "",
      '"@acme/ui@^1.0.0", "@acme/ui@^1.1.0":',
      '  version "1.1.0"',
      '  resolved "https://npm.acme.io/@acme/ui/-/ui-1.1.0.tgz#abc"',
      "",
      "lodash@^4.17.0:",
      '  version "4.17.21"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#def"',
      "",
    ].join("\n"),
  });
  const berry = await repository({
    ".yarnrc.yml": "npmRegistryServer: https://registry.npmjs.org\n",
    "yarn.lock": [
      "__metadata:",
      "  version: 8",
      "",
      '"zod@npm:^4.0.0":',
      '  resolution: "zod@npm:4.0.0"',
      "",
      '"@acme/shared@workspace:packages/shared":',
      '  resolution: "@acme/shared@workspace:packages/shared"',
      "",
    ].join("\n"),
  });
  const unnamed = await repository({
    "yarn.lock": '"zod@npm:^4.0.0":\n  resolution: "zod@npm:4.0.0"\n',
  });
  try {
    const of = packageRegistries(classic);
    assert.deepEqual(of("@acme/ui"), {
      source: "private",
      evidence: "yarn.lock",
    });
    assert.deepEqual(of("lodash"), { source: "public", evidence: "yarn.lock" });
    assert.deepEqual(packageRegistries(berry)("zod"), {
      source: "public",
      evidence: "yarn.lock",
    });
    assert.equal(packageRegistries(berry)("@acme/shared"), null);
    // From whatever registry the developer had configured: no evidence.
    assert.equal(packageRegistries(unnamed)("zod"), null);
  } finally {
    for (const root of [classic, berry, unnamed])
      await rm(root, { recursive: true, force: true });
  }
});

test("Berry reads only .yarnrc.yml, and any file naming another registry makes a package private", async () => {
  const berryLock = [
    "__metadata:",
    "  version: 8",
    "",
    '"acme-internal@npm:^1.0.0":',
    '  resolution: "acme-internal@npm:1.0.0"',
    "",
    '"@acme/core@npm:^1.0.0":',
    '  resolution: "@acme/core@npm:1.0.0"',
    "",
    '"@open/kit@npm:^1.0.0":',
    '  resolution: "@open/kit@npm:1.0.0"',
    "",
  ].join("\n");
  // Berry installs from its own registry; npm's file naming the public one
  // must not make the name look public.
  const proxied = await repository({
    ".yarnrc.yml": "npmRegistryServer: https://npm.acme.io\n",
    ".npmrc": "registry=https://registry.npmjs.org/\n",
    "yarn.lock": berryLock,
  });
  // The same for one scope, and the other way round.
  const scoped = await repository({
    ".yarnrc.yml": [
      "npmScopes:",
      "  acme:",
      "    npmRegistryServer: https://npm.acme.io",
      "",
    ].join("\n"),
    ".npmrc": "@acme:registry=https://registry.npmjs.org/\n",
    "yarn.lock": berryLock,
  });
  const npmPrivate = await repository({
    ".yarnrc.yml": "npmRegistryServer: https://registry.yarnpkg.com\n",
    ".npmrc": "@acme:registry=https://npm.acme.io/\n",
    "yarn.lock": berryLock,
  });
  // `.npmrc` alone names nothing Berry reads.
  const npmOnly = await repository({
    ".npmrc": "registry=https://registry.npmjs.org/\n",
    "yarn.lock": berryLock,
  });
  // A scope `.yarnrc.yml` sends to the public registry, and no default.
  const scopeOnly = await repository({
    ".yarnrc.yml": [
      "npmScopes:",
      "  open:",
      "    npmRegistryServer: https://registry.npmjs.org",
      "",
    ].join("\n"),
    "yarn.lock": berryLock,
  });
  try {
    assert.deepEqual(packageRegistries(proxied)("acme-internal"), {
      source: "private",
      evidence: ".yarnrc.yml",
    });
    const ofScoped = packageRegistries(scoped);
    assert.deepEqual(ofScoped("@acme/core"), {
      source: "private",
      evidence: ".yarnrc.yml",
    });
    // Neither file names a registry for an unscoped package.
    assert.equal(ofScoped("acme-internal"), null);
    const ofNpmPrivate = packageRegistries(npmPrivate);
    assert.deepEqual(ofNpmPrivate("@acme/core"), {
      source: "private",
      evidence: ".npmrc",
    });
    // Yarn's alias of the public registry is the public registry.
    assert.deepEqual(ofNpmPrivate("acme-internal"), {
      source: "public",
      evidence: "yarn.lock",
    });
    assert.equal(packageRegistries(npmOnly)("acme-internal"), null);
    const ofScopeOnly = packageRegistries(scopeOnly);
    assert.deepEqual(ofScopeOnly("@open/kit"), {
      source: "public",
      evidence: "yarn.lock",
    });
    assert.equal(ofScopeOnly("@acme/core"), null);
  } finally {
    for (const root of [proxied, scoped, npmPrivate, npmOnly, scopeOnly])
      await rm(root, { recursive: true, force: true });
  }
});

test("pnpm-lock.yaml: tarball URLs, and integrity pins from a registry the repository names", async () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "  .:",
    "    dependencies:",
    "      zod:",
    "        specifier: ^4.0.0",
    "        version: 4.0.0",
    "",
    "packages:",
    "",
    "  zod@4.0.0:",
    "    resolution: {integrity: sha512-abc}",
    "",
    "  '@acme/ui@1.0.0(react@19.0.0)':",
    "    resolution: {integrity: sha512-def, tarball: https://npm.acme.io/@acme/ui/-/ui-1.0.0.tgz}",
    "",
    "  /left-pad/1.3.0:",
    "    resolution:",
    `      tarball: ${npmjs("left-pad")}`,
    "",
    "  /acme-forms/1.0.0_react@18.0.0:",
    "    resolution: {integrity: sha512-jkl, tarball: https://npm.acme.io/acme-forms/-/acme-forms-1.0.0.tgz}",
    "",
    "  /@acme/grid/2.0.0_react@18.0.0:",
    "    resolution: {integrity: sha512-mno, tarball: https://npm.acme.io/@acme/grid/-/grid-2.0.0.tgz}",
    "",
    "snapshots:",
    "",
    "  react@19.0.0:",
    "    resolution: {integrity: sha512-ghi}",
    "",
  ].join("\n");
  const named = await repository({
    ".npmrc": "registry=https://registry.npmjs.org/\n",
    "pnpm-lock.yaml": lock,
  });
  const unnamed = await repository({ "pnpm-lock.yaml": lock });
  try {
    const of = packageRegistries(named);
    assert.deepEqual(of("zod"), {
      source: "public",
      evidence: "pnpm-lock.yaml",
    });
    assert.deepEqual(of("@acme/ui"), {
      source: "private",
      evidence: "pnpm-lock.yaml",
    });
    assert.equal(of("left-pad")?.source, "public");
    assert.equal(of("react"), null);
    // pnpm 5 keys, whose peer suffix holds an `@` of its own.
    assert.deepEqual(of("acme-forms"), {
      source: "private",
      evidence: "pnpm-lock.yaml",
    });
    assert.equal(of("@acme/grid")?.source, "private");
    const bare = packageRegistries(unnamed);
    assert.equal(bare("zod"), null);
    assert.equal(bare("left-pad")?.source, "public");
  } finally {
    for (const root of [named, unnamed])
      await rm(root, { recursive: true, force: true });
  }
});

test("a repository with no lockfile or configuration says nothing", async () => {
  const root = await repository({ "package.json": "{ not json" });
  try {
    assert.equal(packageRegistries(root)("zod"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
