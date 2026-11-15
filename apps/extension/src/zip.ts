/**
 * The ZIP subset the platform writes and reads (PKWARE APPNOTE 6.3, stored
 * or deflated, no ZIP64, encryption or multi-disk): read to unpack a
 * contribution's archive, written to upload the folder as a submission.
 *
 * The reader is the API's hardened one (`apps/api/src/sandbox/unzip.ts`),
 * mirrored because apps never import each other and the platform-neutral
 * packages may not use `node:zlib`: an archive is refused before anything
 * is inflated when it is not a ZIP, uses what is not read, lists too many
 * entries, names an entry that could land outside the folder (absolute,
 * `..`, `.`, a backslash, a drive letter or a control character) or the
 * same name twice; each entry is inflated no further than its declared
 * size and checked against its length and CRC-32, so a bomb or a lying
 * header is refused rather than allocated. Symbolic links are reported,
 * never written. Unpacking (`workspace.ts`) checks every target path again
 * against the folder on disk.
 *
 * No dependency: the subset is small and `node:zlib` inflates and
 * deflates. The CRC-32 is computed here: `zlib.crc32` is newer than the
 * Node some supported VS Code releases run the extension host on.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP entry carries. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const UNZIP_LIMITS = {
  /** Entries the central directory may list. */
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
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffff_ffff;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (MADE_BY_UNIX << 8) | 20;
const UTF8_NAMES = 0x0800;
const DOS_DATE = (1 << 5) | 1;
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

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
  readonly dataOffset: number;
}

/** Why an archive, or one entry of it, is not read. */
export class ZipError extends Error {
  constructor(
    readonly code:
      | "not_a_zip"
      | "zip_unsupported"
      | "zip_corrupt"
      | "too_many_entries"
      | "unsafe_path"
      | "duplicate_path"
      | "entry_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Why a name could land outside the folder it is extracted to; null when it cannot. */
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

/** Every entry, in central-directory order. Reads headers only; throws `ZipError`. */
export function listZip(bytes: Uint8Array): ZipListing[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22)
    throw new ZipError("not_a_zip", "The file is too short to be a ZIP.");
  const end = endRecord(buffer);
  if (end < 0)
    throw new ZipError("not_a_zip", "The file has no ZIP end record.");
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP64_LOCATOR)
    throw new ZipError("zip_unsupported", "ZIP64 archives are not read.");
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const onDisk = buffer.readUInt16LE(end + 8);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count)
    throw new ZipError(
      "zip_unsupported",
      "Archives split across disks are not read.",
    );
  if (count === 0xffff || centralOffset === 0xffffffff)
    throw new ZipError("zip_unsupported", "ZIP64 archives are not read.");
  if (count > UNZIP_LIMITS.entries)
    throw new ZipError(
      "too_many_entries",
      `The archive lists ${count} entries; at most ${UNZIP_LIMITS.entries} are read.`,
    );
  if (centralOffset + centralSize > end)
    throw new ZipError(
      "zip_corrupt",
      "The central directory runs past its end record.",
    );
  const entries: ZipListing[] = [];
  const names = new Set<string>();
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_HEADER)
      throw new ZipError("zip_corrupt", "A central header is missing.");
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
      throw new ZipError("zip_corrupt", "A central header runs past its end.");
    const raw = decoder.decode(buffer.subarray(at + 46, at + 46 + nameLength));
    at = next;
    if ((flags & ENCRYPTED) !== 0)
      throw new ZipError("zip_unsupported", `${raw} is encrypted.`);
    if (method !== STORED && method !== DEFLATED)
      throw new ZipError(
        "zip_unsupported",
        `${raw} is compressed with method ${method}; only stored and deflated entries are read.`,
      );
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new ZipError("zip_unsupported", "ZIP64 archives are not read.");
    const mode = madeBy === MADE_BY_UNIX ? external >>> 16 : 0;
    const directory =
      raw.endsWith("/") ||
      (mode & S_IFMT) === S_IFDIR ||
      (madeBy !== MADE_BY_UNIX && (external & MSDOS_DIRECTORY) !== 0);
    const name = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (directory && name === "") continue;
    const unsafe = unsafeEntryName(name);
    if (unsafe !== null)
      throw new ZipError("unsafe_path", `${JSON.stringify(raw)}: ${unsafe}`);
    if (names.has(name))
      throw new ZipError(
        "duplicate_path",
        `${name}: the archive holds this name twice.`,
      );
    names.add(name);
    if (
      localOffset + 30 > centralOffset ||
      buffer.readUInt32LE(localOffset) !== LOCAL_HEADER
    )
      throw new ZipError("zip_corrupt", `${name}'s local header is missing.`);
    const dataOffset =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > centralOffset)
      throw new ZipError("zip_corrupt", `${name}'s data runs past its end.`);
    if (method === STORED && compressedSize !== size)
      throw new ZipError("zip_corrupt", `${name}'s sizes disagree.`);
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
 * One entry's bytes, at most `maxBytes`: refused unread when its declared
 * size is over, inflated no further, and checked against its CRC-32.
 */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipListing,
  maxBytes: number,
): Uint8Array {
  if (entry.size > maxBytes)
    throw new ZipError(
      "entry_too_large",
      `${entry.name} is ${entry.size} bytes; a file is read up to ${maxBytes}.`,
    );
  const body = bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let data: Uint8Array = body;
  if (entry.method === DEFLATED)
    try {
      // One byte past the declared size, so a stream that runs on is caught.
      data = inflateRawSync(body, { maxOutputLength: entry.size + 1 });
    } catch {
      throw new ZipError(
        "zip_corrupt",
        `${entry.name} does not inflate to its declared size.`,
      );
    }
  if (data.byteLength !== entry.size || crc32(data) !== entry.crc)
    throw new ZipError(
      "zip_corrupt",
      `${entry.name} does not match its size and checksum.`,
    );
  return data;
}

/** One file to write: its name in the archive (checked by the caller) and bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * The archive of `entries`, in order: deflated where that shrinks a file,
 * stored otherwise, with a fixed time so the same files make the same
 * bytes. Throws a RangeError past what a non-ZIP64 archive holds.
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > ZIP_MAX_ENTRIES)
    throw new RangeError("Too many files for a ZIP archive.");
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.bytes);
    const deflated = deflateRawSync(entry.bytes);
    const method =
      deflated.byteLength < entry.bytes.byteLength ? DEFLATED : STORED;
    const body = method === DEFLATED ? deflated : entry.bytes;
    if (offset + 30 + name.byteLength + body.byteLength > ZIP_MAX_BYTES)
      throw new RangeError("Too large for a ZIP archive without ZIP64.");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    chunks.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.byteLength, 20);
    header.writeUInt32LE(entry.bytes.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt32LE(FILE_ATTRIBUTES, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
