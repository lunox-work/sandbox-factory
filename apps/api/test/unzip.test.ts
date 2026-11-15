import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isZipProblem,
  listZip,
  readZipEntry,
  unsafeEntryName,
  UNZIP_LIMITS,
  type ZipListing,
} from "../src/sandbox/unzip.js";
import { zip } from "../src/sandbox/zip.js";

/** An archive of `files`, as the platform's own writer makes it. */
async function archive(
  files: readonly [string, string | Uint8Array][],
): Promise<Buffer> {
  const made = await zip(
    files.map(([name, content]) => ({
      name,
      bytes: typeof content === "string" ? Buffer.from(content) : content,
    })),
  );
  return Buffer.concat(made.chunks);
}

/** Where the first central header starts. */
const central = (bytes: Buffer) => bytes.readUInt32LE(bytes.length - 22 + 16);

const listed = (bytes: Uint8Array): ZipListing[] => {
  const entries = listZip(bytes);
  assert.ok(!isZipProblem(entries), JSON.stringify(entries));
  return entries;
};

test("an archive is listed from its central directory and each entry read back", async () => {
  const body = "export const fee = () => 25;\n".repeat(50);
  const bytes = await archive([
    ["sbx-v1/src/fees.ts", body],
    ["sbx-v1/empty.txt", ""],
    ["./sbx-v1/notes/", ""],
  ]);
  const entries = listed(bytes);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.directory]),
    [
      ["sbx-v1/src/fees.ts", false],
      ["sbx-v1/empty.txt", false],
      ["sbx-v1/notes", true],
    ],
  );
  const [fees, empty] = entries;
  assert.ok(fees !== undefined && empty !== undefined);
  assert.equal(fees.method, 8, "deflated");
  assert.equal(
    Buffer.from(readZipEntry(bytes, fees, 1_000_000) as Uint8Array).toString(),
    body,
  );
  assert.equal((readZipEntry(bytes, empty, 10) as Uint8Array).byteLength, 0);
});

test("names that could escape the folder, and the same name twice, are refused", async () => {
  for (const name of [
    "../evil.ts",
    "a/../../evil.ts",
    "/etc/passwd",
    "C:/Windows/x",
    "src\\fees.ts",
    "a//b",
    "a/./b",
    "bell\u0007",
  ]) {
    const problem = listZip(await archive([[name, "x"]]));
    assert.ok(isZipProblem(problem), name);
    assert.equal(problem.code, "unsafe_path", name);
  }
  assert.equal(unsafeEntryName("src/fees.ts"), null);
  const twice = listZip(
    await archive([
      ["a.ts", "1"],
      ["a.ts", "2"],
    ]),
  );
  assert.ok(isZipProblem(twice));
  assert.equal(twice.code, "duplicate_path");
});

test("symbolic links are reported by their Unix mode, never followed", async () => {
  const bytes = await archive([
    ["link.ts", "/etc/passwd"],
    ["plain.ts", "x"],
  ]);
  bytes.writeUInt32LE((0o120777 << 16) >>> 0, central(bytes) + 38);
  const [link, plain] = listed(bytes);
  assert.equal(link?.symlink, true);
  assert.equal(plain?.symlink, false);
});

test("what cannot be checked is refused: not a ZIP, encryption, other methods, ZIP64, too many entries", async () => {
  for (const bytes of [new Uint8Array(10), Buffer.from("PK not really a zip")])
    assert.equal((listZip(bytes) as { code: string }).code, "not_a_zip");

  const encrypted = await archive([["a.ts", "x"]]);
  encrypted.writeUInt16LE(1, central(encrypted) + 8);
  assert.equal(
    (listZip(encrypted) as { code: string }).code,
    "zip_unsupported",
  );

  const bzip = await archive([["a.ts", "x"]]);
  bzip.writeUInt16LE(12, central(bzip) + 10);
  assert.equal((listZip(bzip) as { code: string }).code, "zip_unsupported");

  const zip64 = await archive([["a.ts", "x"]]);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 8);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  assert.equal((listZip(zip64) as { code: string }).code, "zip_unsupported");

  const many = await archive([["a.ts", "x"]]);
  many.writeUInt16LE(UNZIP_LIMITS.entries + 1, many.length - 22 + 8);
  many.writeUInt16LE(UNZIP_LIMITS.entries + 1, many.length - 22 + 10);
  assert.equal((listZip(many) as { code: string }).code, "too_many_entries");

  const truncated = (await archive([["a.ts", "x"]])).subarray(0, 40);
  assert.equal((listZip(truncated) as { code: string }).code, "not_a_zip");
});

test("an entry is inflated no further than its declared size, and checked", async () => {
  const body = "a".repeat(100_000);
  const bytes = await archive([["big.txt", body]]);
  const [entry] = listed(bytes);
  assert.ok(entry !== undefined);
  // Over the caller's cap: refused unread.
  const capped = readZipEntry(bytes, entry, 1_000);
  assert.ok(isZipProblem(capped));
  assert.equal(capped.code, "entry_too_large");
  // A header that understates what the stream inflates to: a bomb's trick.
  const lying = { ...entry, size: 1_000 };
  const bomb = readZipEntry(bytes, lying, 1_000_000);
  assert.ok(isZipProblem(bomb));
  assert.equal(bomb.code, "zip_corrupt");
  // A checksum that does not match.
  const bad = readZipEntry(bytes, { ...entry, crc: entry.crc ^ 1 }, 1_000_000);
  assert.ok(isZipProblem(bad));
  assert.equal(bad.code, "zip_corrupt");
});
