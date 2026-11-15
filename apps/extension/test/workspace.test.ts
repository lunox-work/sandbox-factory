import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  collectFolder,
  folderState,
  readNote,
  unpackArchive,
  writeNote,
} from "../src/workspace.js";
import { listZip, readZipEntry, zip, ZipError } from "../src/zip.js";
import { rawZip, text } from "./zip-fixtures.js";

const made: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lunox-ext-"));
  made.push(dir);
  return dir;
}
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const archive = (files: Record<string, string>) =>
  zip(
    Object.entries(files).map(([name, value]) => ({
      name,
      bytes: text(value),
    })),
  );

const zipCode = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return null;
};

test("an archive unpacks into the folder with its top folder stripped", async () => {
  const dir = await scratch();
  const target = join(dir, "work");
  assert.equal(await folderState(target), "missing");
  const result = await unpackArchive(
    archive({
      "sbx_1-v2/package.json": "{}\n",
      "sbx_1-v2/src/fees.ts": "export const fee = () => 0;\n",
    }),
    target,
  );
  assert.deepEqual(result, { files: 2, root: "sbx_1-v2" });
  assert.equal(
    await readFile(join(target, "src", "fees.ts"), "utf8"),
    "export const fee = () => 0;\n",
  );
  assert.equal(await folderState(target), "occupied");
  const empty = join(dir, "empty");
  await mkdir(empty);
  await writeFile(join(empty, ".DS_Store"), "");
  assert.equal(await folderState(empty), "empty");
  // An archive with files at its root unpacks as it is.
  const flat = join(dir, "flat");
  assert.deepEqual(
    await unpackArchive(archive({ "a.ts": "a", "b/c.ts": "c" }), flat),
    { files: 2, root: "" },
  );
  assert.equal(await readFile(join(flat, "b", "c.ts"), "utf8"), "c");
  await assert.rejects(folderState(join(flat, "a.ts")), /ENOTDIR/);
});

test("nothing is written outside the folder: unsafe names, links in the archive or on disk", async () => {
  const dir = await scratch();
  const outside = join(dir, "outside");
  await mkdir(outside);
  const target = join(dir, "target");
  assert.equal(
    await zipCode(() => unpackArchive(rawZip([{ name: "../x.ts" }]), target)),
    "unsafe_path",
  );
  assert.equal(
    await zipCode(() =>
      unpackArchive(rawZip([{ name: "r/l", mode: 0o120777 }]), target),
    ),
    "unsafe_path",
  );
  // A folder being overwritten that already holds a link out of it.
  await mkdir(target, { recursive: true });
  await symlink(outside, join(target, "src"));
  assert.equal(
    await zipCode(() =>
      unpackArchive(archive({ "r/src/evil.ts": "x", "r/a.ts": "a" }), target),
    ),
    "unsafe_path",
  );
  await symlink(join(outside, "file.ts"), join(target, "file.ts"));
  assert.equal(
    await zipCode(() =>
      unpackArchive(archive({ "r/file.ts": "x", "r/b.ts": "b" }), target),
    ),
    "unsafe_path",
  );
  assert.equal(await folderState(outside), "empty");
});

test("the note names the version and platform, never a token, and reads back strictly", async () => {
  const dir = await scratch();
  assert.equal(await readNote(dir), null);
  const note = {
    schemaVersion: 1,
    versionId: "sbv_1",
    root: "sbx_1-v2",
    platformUrl: "https://platform.lunox.work",
  } as const;
  await writeNote(dir, note);
  assert.deepEqual(await readNote(dir), note);
  const raw = await readFile(join(dir, ".lunox", "contribution.json"), "utf8");
  assert.doesNotMatch(raw, /lnxc_|token/);
  for (const bad of ["[]", "null", '{"schemaVersion":2}', "{"]) {
    await writeFile(join(dir, ".lunox", "contribution.json"), bad);
    assert.equal(await readNote(dir), null, bad);
  }
});

test("the folder zips without installed packages, version control, the note or build output", async () => {
  const dir = await scratch();
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "src/fees.ts": "export const fee = () => 25;\n",
    "src/fees.js": "built",
    "src/fees.js.map": "{}",
    "src/vendor.js": "the version's own",
    "src/new.ts": "export {};\n",
    "src/new.js": "built",
    "node_modules/typescript/lib/tsc.js": "x",
    ".git/HEAD": "ref",
    ".lunox/contribution.json": "{}",
    ".DS_Store": "",
  };
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(join(dir, ...path.split("/")), value);
  }
  await symlink(join(dir, "package.json"), join(dir, "src", "link.ts"));
  const collected = await collectFolder(
    dir,
    new Set(["package.json", "src/fees.ts", "src/vendor.js"]),
  );
  assert.deepEqual(
    collected.entries.map((entry) => entry.name),
    ["package.json", "src/fees.ts", "src/new.ts", "src/vendor.js"],
  );
  // node_modules, .git, .lunox, .DS_Store, and three build outputs.
  assert.equal(collected.skipped, 7);
  assert.deepEqual(collected.links, ["src/link.ts"]);
  // The upload reads back as the same files.
  const bytes = zip(collected.entries);
  const back = listZip(bytes).map((entry) => [
    entry.name,
    new TextDecoder().decode(readZipEntry(bytes, entry, 1 << 20)),
  ]);
  assert.deepEqual(back[1], ["src/fees.ts", "export const fee = () => 25;\n"]);
});
