/**
 * A hardened ZIP reader for archives people upload (a contributor's
 * zipped project folder), the counterpart of `zip.ts`'s writer: the
 * subset every zipper writes (PKWARE APPNOTE 6.3, stored or deflated),
 * read from the end record and the central directory, and nothing it
 * cannot check.
 *
 * Refused outright, before anything is inflated: anything but a ZIP; ZIP64,
 * encryption, multi-disk archives and other methods (`zip_unsupported`);
 * more than `UNZIP_LIMITS.entries` entries; an entry whose name could
 * write outside the folder an unzipper extracts to (absolute, `..`, `.`,
 * a backslash, a drive letter or a control character: `unsafe_path`), or
 * the same name twice. Symbolic links (a Unix mode in the external
 * attributes) are reported, never followed; the caller decides.
 *
 * Inflating is per entry and bounded (`readZipEntry`): the declared size
 * is checked against the caller's cap first, inflation stops at the
 * declared size, and the result's length and CRC-32 must match, so a
 * bomb or a lying header is refused rather than allocated.
 *
 * Written here rather than added as a dependency, as the writer is: the
 * subset is small, every bound is ours to set, and `node:zlib` does the
 * inflating.
 */

import { crc32, inflateRawSync } from "node:zlib";

export const UNZIP_LIMITS = {
  /** Entries the central directory may list, skipped ones included. */
  entries: 60_000,
} as const;

const END_OF_CENTRAL = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x0001;
const MADE_BY_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const MSDOS_DIRECTORY = 0x10;

/** One entry as the central directory lists it. */
export interface ZipListing {
  /** Its name, `/`-separated, with no leading `./` or trailing `/`. */
  readonly name: string;
  readonly directory: boolean;
  readonly symlink: boolean;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Where its data starts, past the local header. */
  readonly dataOffset: number;
}

export type ZipProblem =
  | { readonly code: "not_a_zip"; readonly detail: string }
  | { readonly code: "zip_unsupported"; readonly detail: string }
  | { readonly code: "zip_corrupt"; readonly detail: string }
  | { readonly code: "too_many_entries"; readonly detail: string }
  | {
      readonly code: "unsafe_path";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "duplicate_path";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "entry_too_large";
      readonly detail: string;
      readonly path: string;
    };

export const isZipProblem = (value: unknown): value is ZipProblem =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  "detail" in value;

const decoder = new TextDecoder("utf-8");

/**
 * Why an entry's name could land outside the folder it is extracted to;
 * null when it cannot. A directory's trailing `/` and a leading `./` are
 * read away first.
 */
export function unsafeEntryName(name: string): string | null {
  if (name === "") return "The name is empty.";
  if (/[\\\0-\x1f\x7f]/.test(name))
    return "The name holds a backslash or a control character.";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name))
    return "The name is absolute.";
  if (
    name
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return "The name has an empty, `.` or `..` segment.";
  return null;
}

/** The end record's offset: the last signature whose comment fits exactly. */
function endRecord(buffer: Buffer): number {
  const last = buffer.length - 22;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at--)
    if (
      buffer.readUInt32LE(at) === END_OF_CENTRAL &&
      at + 22 + buffer.readUInt16LE(at + 20) === buffer.length
    )
      return at;
  return -1;
}

/**
 * Every entry of an archive, in central-directory order, or the first
 * reason it cannot be read safely. Reads headers only.
 */
export function listZip(bytes: Uint8Array): ZipListing[] | ZipProblem {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22)
    return { code: "not_a_zip", detail: "The file is too short to be a ZIP." };
  const end = endRecord(buffer);
  if (end < 0)
    return { code: "not_a_zip", detail: "The file has no ZIP end record." };
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP64_LOCATOR)
    return { code: "zip_unsupported", detail: "ZIP64 archives are not read." };
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const onDisk = buffer.readUInt16LE(end + 8);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count)
    return {
      code: "zip_unsupported",
      detail: "Archives split across disks are not read.",
    };
  if (count === 0xffff || centralOffset === 0xffffffff)
    return { code: "zip_unsupported", detail: "ZIP64 archives are not read." };
  if (count > UNZIP_LIMITS.entries)
    return {
      code: "too_many_entries",
      detail: `The archive lists ${count} entries; at most ${UNZIP_LIMITS.entries} are read.`,
    };
  if (centralOffset + centralSize > end)
    return {
      code: "zip_corrupt",
      detail: "The central directory runs past its end record.",
    };
  const entries: ZipListing[] = [];
  const names = new Set<string>();
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_HEADER)
      return { code: "zip_corrupt", detail: "A central header is missing." };
    const madeBy = buffer.readUInt16LE(at + 4) >> 8;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const external = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end)
      return {
        code: "zip_corrupt",
        detail: "A central header runs past its end.",
      };
    const raw = decoder.decode(buffer.subarray(at + 46, at + 46 + nameLength));
    at = next;
    if ((flags & ENCRYPTED) !== 0)
      return {
        code: "zip_unsupported",
        detail: `${raw} is encrypted; encrypted archives are not read.`,
      };
    if (method !== STORED && method !== DEFLATED)
      return {
        code: "zip_unsupported",
        detail: `${raw} is compressed with method ${method}; only stored and deflated entries are read.`,
      };
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    )
      return {
        code: "zip_unsupported",
        detail: "ZIP64 archives are not read.",
      };
    const mode = madeBy === MADE_BY_UNIX ? external >>> 16 : 0;
    const directory =
      raw.endsWith("/") ||
      (mode & S_IFMT) === S_IFDIR ||
      (madeBy !== MADE_BY_UNIX && (external & MSDOS_DIRECTORY) !== 0);
    const name = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (directory && name === "") continue;
    const unsafe = unsafeEntryName(name);
    if (unsafe !== null)
      return { code: "unsafe_path", detail: unsafe, path: raw };
    if (names.has(name))
      return {
        code: "duplicate_path",
        detail: "The archive holds this name twice.",
        path: name,
      };
    names.add(name);
    if (localOffset + 30 > centralOffset)
      return {
        code: "zip_corrupt",
        detail: `${name}'s local header is missing.`,
      };
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER)
      return {
        code: "zip_corrupt",
        detail: `${name}'s local header is missing.`,
      };
    const dataOffset =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > centralOffset)
      return {
        code: "zip_corrupt",
        detail: `${name}'s data runs past its end.`,
      };
    if (method === STORED && compressedSize !== size)
      return { code: "zip_corrupt", detail: `${name}'s sizes disagree.` };
    entries.push({
      name,
      directory,
      symlink: (mode & S_IFMT) === S_IFLNK,
      method,
      crc,
      compressedSize,
      size,
      dataOffset,
    });
  }
  return entries;
}

/**
 * One entry's bytes, at most `maxBytes` of them: refused unread when its
 * declared size is over, inflated no further than that size, and checked
 * against its length and CRC-32.
 */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipListing,
  maxBytes: number,
): Uint8Array | ZipProblem {
  if (entry.size > maxBytes)
    return {
      code: "entry_too_large",
      detail: `It is ${entry.size} bytes; a file is read up to ${maxBytes}.`,
      path: entry.name,
    };
  const body = bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let data: Uint8Array;
  if (entry.method === STORED) data = body;
  else
    try {
      // One byte past the declared size, so a stream that runs on is caught
      // by length rather than cut to fit.
      data = inflateRawSync(body, { maxOutputLength: entry.size + 1 });
    } catch {
      return {
        code: "zip_corrupt",
        detail: `${entry.name} does not inflate to its declared size.`,
      };
    }
  if (data.byteLength !== entry.size || crc32(data) !== entry.crc)
    return {
      code: "zip_corrupt",
      detail: `${entry.name} does not match its size and checksum.`,
    };
  return data;
}
