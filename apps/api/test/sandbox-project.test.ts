import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { StoredArtifact } from "@sandbox-factory/db";
import { Hono } from "hono";

import type { AuthVariables } from "../src/routes.js";
import {
  isSafeProjectPath,
  projectArchive,
  projectPage,
  rootOf,
  type PublicProject,
} from "../src/sandbox/project.js";
import {
  matchesEtag,
  mergePatchOf,
  mountSandboxRoutes,
  type SandboxRouteOptions,
} from "../src/sandbox/routes.js";
import { zip } from "../src/sandbox/zip.js";
import { memoryObjects } from "./github-fakes.js";
import { unzip } from "./zip-reader.js";

/**
 * The public project a contributor downloads: the zip writer, the project
 * builder, and a round trip through the routes over an in-memory object
 * store, from what a build commits to what `npm ci && npm test` would see.
 */

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("the zip writer stores what deflate cannot shrink, deflates the rest, and is deterministic", async () => {
  const entries = [
    { name: "a/empty.txt", bytes: new Uint8Array() },
    { name: "a/x.txt", bytes: Buffer.from("x") },
    { name: "a/long.txt", bytes: Buffer.from("abc".repeat(10_000)) },
    { name: "a/naïve 名前.md", bytes: Buffer.from("# hi\n") },
  ];
  const archive = await zip(entries);
  const bytes = Buffer.concat(archive.chunks);
  assert.equal(bytes.length, archive.sizeBytes);
  // Far smaller than the 30,000 bytes it holds: the long file deflated.
  assert.ok(bytes.length < 1_000, String(bytes.length));
  const read = unzip(bytes);
  assert.deepEqual(
    read.map(({ name, bytes: body }) => [name, body.toString("utf8")]),
    entries.map(({ name, bytes: body }) => [
      name,
      Buffer.from(body).toString("utf8"),
    ]),
  );
  // Names are flagged UTF-8; the tiny file is stored, the long deflated.
  assert.equal(bytes.readUInt16LE(6), 0x0800);
  assert.equal(bytes.readUInt16LE(8), 0);
  // The same files, the same bytes: the ETag can name them.
  assert.deepEqual(Buffer.concat((await zip(entries)).chunks), bytes);
  // An empty archive is only its end record.
  assert.equal((await zip([])).sizeBytes, 22);
  await assert.rejects(
    zip(
      Array.from({ length: 0x10000 }, (_, index) => ({
        name: `f${index}`,
        bytes: new Uint8Array(),
      })),
    ),
    RangeError,
  );
});

test("a project path is packed only where an unzipper writes it under the root", () => {
  for (const path of [
    "package.json",
    "src/a b/c.ts",
    ".github/workflows/ci.yml",
    "名前.md",
  ])
    assert.equal(isSafeProjectPath(path), true, path);
  for (const path of [
    "",
    "/etc/passwd",
    "../up.ts",
    "src/../../up.ts",
    "src/./a.ts",
    "src//a.ts",
    "src/",
    "src\\a.ts",
    "C:/a.ts",
    "a\u0000b",
    "a\nb",
  ])
    assert.equal(isSafeProjectPath(path), false, JSON.stringify(path));
  assert.equal(rootOf("sbx_AB12", 3), "sbx_ab12-v3");
  assert.equal(rootOf("sbx 1/../x", 1), "sbx-1----x-v1");
  assert.equal(rootOf("", 2), "sandbox-v2");
});

test("If-None-Match names an ETag weakly, in a list, or as any", () => {
  assert.equal(matchesEtag(undefined, '"a"'), false);
  assert.equal(matchesEtag('"a"', '"a"'), true);
  assert.equal(matchesEtag('W/"a"', '"a"'), true);
  assert.equal(matchesEtag('"b", W/"a"', '"a"'), true);
  assert.equal(matchesEtag("*", '"a"'), true);
  assert.equal(matchesEtag('"b"', '"a"'), false);
});

test("a merge patch is read only in its shape: a base commit and whole files", () => {
  const bytes = (value: unknown) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  assert.deepEqual(
    mergePatchOf(
      bytes({
        schemaVersion: 1,
        commitSha: "a".repeat(40),
        files: [{ path: "src/a.ts", text: "x", extra: 1 }],
      }),
    ),
    { commitSha: "a".repeat(40), files: [{ path: "src/a.ts", text: "x" }] },
  );
  for (const damaged of [
    "{",
    "[]",
    "null",
    { commitSha: "main", files: [] },
    { commitSha: "abcd", files: "x" },
    { commitSha: "abcd", files: [null] },
    { commitSha: "abcd", files: [{ path: "", text: "" }] },
    { commitSha: "abcd", files: [{ path: "a", text: 1 }] },
  ])
    assert.equal(mergePatchOf(bytes(damaged)), null, JSON.stringify(damaged));
});

/** What a build of a small Node project commits: public and private. */
const committed: Record<string, string> = {
  "project/package.json": JSON.stringify(
    {
      name: "northwind-fees",
      private: true,
      type: "module",
      scripts: { build: "tsc", test: "node --test" },
    },
    null,
    2,
  ),
  "project/package-lock.json": JSON.stringify({
    name: "northwind-fees",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "northwind-fees" } },
  }),
  "project/README.md": "# Fees\n\nRun `npm ci && npm test`.\n",
  "project/src/fees.ts":
    "export function flatCharge(amount: number): number {\n  return amount;\n}\n",
  "project/src/rates.json": JSON.stringify(
    Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`r${i}`, i / 7])),
  ),
  "project/test/fees.test.ts":
    "import { test } from 'node:test';\ntest('charges', () => {});\n",
  "project/assets/mark.bin": "\u0000\u0001\u0002binary",
  "private/s1-flat-charge.test.ts":
    "test('flat charge is waived under ten', () => {});\n",
  "private/merge-patch.json": JSON.stringify({ commitSha: "b".repeat(40) }),
  "build-manifest.json": JSON.stringify({ hidden: ["s1-flat-charge"] }),
};

function roundTrip() {
  const objects = memoryObjects();
  const artifacts: StoredArtifact[] = Object.entries(committed).map(
    ([path, text]) => {
      const body = Buffer.from(text);
      const objectKey = `runs/arn_build/lease/${path}`;
      objects.objects.set(objectKey, body);
      return {
        id: `art_${path}`,
        runId: "arn_build",
        kind: "build_manifest",
        path,
        objectKey,
        contentType: "application/octet-stream",
        sizeBytes: body.length,
        sha256: sha(body),
        meta: null,
        createdAt: "2026-11-15T00:00:00.000Z",
      } as StoredArtifact;
    },
  );
  const options = {
    sandboxes: {
      getVersion: async (owner: string, id: string) =>
        owner === "org_1" && id === "sbv_7"
          ? {
              version: { id: "sbv_7", sandboxId: "sbx_9", version: 4 },
              source: { buildRunId: "arn_build" },
            }
          : null,
    },
    runs: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "arn_build"
          ? { id, status: "succeeded" }
          : null,
    },
    artifacts: {
      list: async (owner: string, runId: string) =>
        owner === "org_1" && runId === "arn_build" ? artifacts : [],
    },
    objects,
  } as unknown as SandboxRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("member", {
      role: "owner",
      organizationId: c.req.param("orgId"),
    } as never);
    c.set("principal", { via: "token" } as never);
    await next();
  });
  mountSandboxRoutes(app, options);
  const get = (path: string) =>
    app.request(`/api/v1/orgs/org_1/sandboxes/versions/sbv_7${path}`);
  return { get, objects };
}

test("round trip: the archive unpacks to the handout's files, the tree npm ci and npm test run in, and no hidden test", async () => {
  const { get } = roundTrip();
  const handout = (await (await get("/handout")).json()) as {
    files: { path: string; sizeBytes: number; sha256: string }[];
    hiddenTests: number;
  };
  assert.equal(handout.hiddenTests, 2);
  const response = await get("/archive");
  assert.equal(response.status, 200);
  const entries = unzip(new Uint8Array(await response.arrayBuffer()));
  const root = "sbx_9-v4/";
  assert.ok(entries.every(({ name }) => name.startsWith(root)));
  const unpacked = entries.map(({ name, bytes }) => ({
    path: name.slice(root.length),
    sizeBytes: bytes.length,
    sha256: sha(bytes),
  }));
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  // The handout's list and hashes, exactly.
  assert.deepEqual([...unpacked].sort(byPath), [...handout.files].sort(byPath));
  // The worker's `project/`, exactly, byte for byte: the tree a contributor
  // runs `npm ci && npm test` in is the one the build's baseline ran in.
  const project = Object.entries(committed)
    .filter(([path]) => path.startsWith("project/"))
    .map(([path, text]) => [path.slice("project/".length), text]);
  assert.deepEqual(
    entries
      .map(({ name, bytes }) => [name.slice(root.length), bytes.toString()])
      .sort(),
    project.sort(),
  );
  const paths = unpacked.map(({ path }) => path);
  assert.ok(
    paths.includes("package.json") && paths.includes("package-lock.json"),
  );
  for (const path of paths) {
    assert.doesNotMatch(path, /(^|\/)tests?\/private(\/|$)|^private\//, path);
    assert.notEqual(path, "build-manifest.json");
  }

  // The same files, page by page, as an agent writes them out.
  const pages: {
    path: string;
    encoding: string | null;
    content: string | null;
  }[] = [];
  let cursor: string | null = null;
  let count = 0;
  do {
    const query: string =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const page = (await (
      await get(`/handout/files?maxBytes=1000${query}`)
    ).json()) as {
      root: string;
      total: number;
      files: typeof pages;
      nextCursor: string | null;
    };
    assert.equal(page.root, "sbx_9-v4");
    assert.equal(page.total, project.length);
    assert.ok(page.files.length > 0);
    pages.push(...page.files);
    cursor = page.nextCursor;
    count++;
  } while (cursor !== null);
  // `rates.json` alone is over the page: more than one page was read.
  assert.ok(count > 1, String(count));
  assert.deepEqual(
    pages
      .map(({ path, encoding, content }) => [
        path,
        Buffer.from(
          content ?? "",
          encoding === "base64" ? "base64" : "utf8",
        ).toString(),
      ])
      .sort(),
    project.sort(),
  );
  assert.equal(
    pages.find(({ path }) => path === "assets/mark.bin")?.encoding,
    "base64",
  );
});

test("a project is refused, never partly served, when storage lost or changed a file", async () => {
  const { get, objects } = roundTrip();
  const key = "runs/arn_build/lease/project/src/fees.ts";
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    objects.objects.delete(key);
    const lost = await get("/archive");
    assert.equal(lost.status, 502);
    assert.equal(
      ((await lost.json()) as { code: string }).code,
      "artifacts_unavailable",
    );
    // The same length, other bytes: the hash catches it.
    objects.objects.set(
      key,
      Buffer.from(committed["project/src/fees.ts"] ?? "").fill(0x61),
    );
    const changed = await get("/archive");
    assert.equal(changed.status, 502);
    assert.equal(
      ((await changed.json()) as { code: string }).code,
      "project_mismatch",
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    logged.map(([code]) => code),
    ["project_artifacts_unavailable", "project_project_mismatch"],
  );
});

const projectOf = (
  files: { path: string; sizeBytes: number }[],
): PublicProject => ({
  versionId: "sbv_1",
  run: { id: "arn_1", status: "succeeded" },
  artifacts: [],
  root: "sbx_1-v1",
  files: files.map((file) => ({
    ...file,
    sha256: "0".repeat(64),
    objectKey: `k/${file.path}`,
  })),
});

test("a project too large, with too many files or an unsafe path is refused before a byte is read", async () => {
  const objects = {
    get: () => Promise.reject(new Error("nothing should be read")),
  };
  assert.deepEqual(
    await projectArchive(
      objects,
      projectOf([{ path: "big.bin", sizeBytes: 64 * 1024 * 1024 + 1 }]),
    ),
    { code: "project_too_large" },
  );
  assert.deepEqual(
    await projectArchive(
      objects,
      projectOf(
        Array.from({ length: 0x10000 }, (_, i) => ({
          path: `f${i}`,
          sizeBytes: 0,
        })),
      ),
    ),
    { code: "project_too_large" },
  );
  assert.deepEqual(
    await projectArchive(
      objects,
      projectOf([{ path: "../escape.ts", sizeBytes: 1 }]),
    ),
    { code: "unsafe_path", path: "../escape.ts" },
  );
  assert.deepEqual(await projectArchive(objects, projectOf([])), {
    code: "not_built",
  });
  assert.deepEqual(await projectPage(objects, projectOf([]), null, 1_000), {
    code: "not_built",
  });
});

test("a page of many small files stops at its file limit", async () => {
  const files = Array.from({ length: 250 }, (_, i) => ({
    path: `f${String(i).padStart(3, "0")}.txt`,
    sizeBytes: 1,
  }));
  const project: PublicProject = {
    ...projectOf(files),
    files: files.map((file) => ({
      ...file,
      sha256: sha("x"),
      objectKey: "x",
    })),
  };
  const objects = { get: async () => Buffer.from("x") };
  const first = await projectPage(objects, project, null, 1_000_000);
  assert.ok("files" in first);
  assert.equal(first.files.length, 200);
  assert.ok(first.nextCursor !== null);
  const second = await projectPage(
    objects,
    project,
    first.nextCursor,
    1_000_000,
  );
  assert.ok("files" in second);
  assert.equal(second.files.length, 50);
  assert.equal(second.nextCursor, null);
  assert.equal(second.files[0]?.path, "f200.txt");
});
