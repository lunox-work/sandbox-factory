import assert from "node:assert/strict";
import { test } from "node:test";

import { rawZip, text } from "./zip-fixtures.js";
import {
  crc32,
  listZip,
  readZipEntry,
  unsafeEntryName,
  zip,
  ZipError,
} from "../src/zip.js";

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return null;
};

test("what the writer packs, the reader reads back byte for byte", () => {
  const big = text("export const fee = () => 25;\n".repeat(200));
  const archive = zip([
    { name: "src/fees.ts", bytes: big },
    { name: "a.bin", bytes: new Uint8Array([0, 255, 7]) },
  ]);
  const entries = listZip(archive);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.method, entry.size]),
    [
      ["src/fees.ts", 8, big.byteLength],
      ["a.bin", 0, 3],
    ],
  );
  const [fees, bin] = entries;
  assert.ok(fees !== undefined && bin !== undefined);
  assert.deepEqual([...readZipEntry(archive, fees, 1 << 20)], [...big]);
  assert.deepEqual([...readZipEntry(archive, bin, 10)], [0, 255, 7]);
  // The same files always make the same bytes.
  assert.deepEqual(
    zip([{ name: "a", bytes: big }]),
    zip([{ name: "a", bytes: big }]),
  );
  assert.equal(crc32(text("123456789")), 0xcbf43926);
});

test("unsafe names, links, bombs and unsupported archives are refused before inflating", () => {
  for (const name of [
    "",
    "/etc/passwd",
    "C:/x",
    "a/../b",
    "a//b",
    "a/./b",
    "a\\b",
    "a/\u0001",
  ])
    assert.notEqual(unsafeEntryName(name), null, name);
  assert.equal(unsafeEntryName("src/fees.ts"), null);
  assert.equal(
    codeOf(() => listZip(rawZip([{ name: "../evil.ts" }]))),
    "unsafe_path",
  );
  assert.equal(
    codeOf(() => listZip(rawZip([{ name: "a.ts" }, { name: "./a.ts" }]))),
    "duplicate_path",
  );
  assert.equal(
    codeOf(() => listZip(rawZip([{ name: "a", flags: 1 }]))),
    "zip_unsupported",
  );
  assert.equal(
    codeOf(() => listZip(rawZip([{ name: "a", method: 12 }]))),
    "zip_unsupported",
  );
  assert.equal(
    codeOf(() => listZip(text("not a zip at all, but long enough"))),
    "not_a_zip",
  );
  assert.equal(
    codeOf(() => listZip(text("PK"))),
    "not_a_zip",
  );
  const link = listZip(rawZip([{ name: "l", mode: 0o120777 }]))[0];
  assert.equal(link?.symlink, true);
  const directory = listZip(
    rawZip([{ name: "src/", mode: 0o040755 }, { name: "./" }]),
  );
  assert.deepEqual(
    directory.map((entry) => [entry.name, entry.directory]),
    [["src", true]],
  );
  // A bomb: declared small, inflating to more.
  const bomb = rawZip([
    { name: "b", data: new Uint8Array(1 << 16), method: 8, declaredSize: 10 },
  ]);
  const entry = listZip(bomb)[0];
  assert.ok(entry !== undefined);
  assert.equal(
    codeOf(() => readZipEntry(bomb, entry, 1 << 20)),
    "zip_corrupt",
  );
  assert.equal(
    codeOf(() => readZipEntry(bomb, entry, 5)),
    "entry_too_large",
  );
  // A lying checksum.
  const archive = zip([{ name: "a", bytes: text("abc") }]);
  const listed = listZip(archive)[0];
  assert.ok(listed !== undefined);
  assert.equal(
    codeOf(() => readZipEntry(archive, { ...listed, crc: 1 }, 10)),
    "zip_corrupt",
  );
  // A truncated central directory.
  assert.equal(
    codeOf(() => listZip(archive.subarray(0, archive.byteLength - 30))),
    "not_a_zip",
  );
  assert.throws(
    () =>
      zip(
        Array.from({ length: 0x10000 }, () => ({
          name: "a",
          bytes: new Uint8Array(),
        })),
      ),
    RangeError,
  );
});
