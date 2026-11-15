/**
 * A minimal ZIP writer (PKWARE APPNOTE 6.3, the subset every unzipper
 * reads): one local header and body per file, then the central directory
 * and its end record. Deflated with node:zlib, or stored when deflating
 * does not shrink a file. No ZIP64, encryption, extra fields or comments;
 * names are UTF-8 (flag bit 11). Every entry has the same fixed time
 * (1980-01-01 00:00, the format's epoch) and mode 0644, so the same files
 * always make the same bytes: the archive's ETag is a hash of its inputs.
 *
 * Written here rather than added as a dependency: the format subset is
 * small, and the archive route must not grow the API's install.
 */

import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);

/** One file: its name in the archive (already checked) and its bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The most entries an archive without ZIP64 can count. */
export const ZIP_MAX_ENTRIES = 0xffff;
/** The largest offset or size a 32-bit field can hold. */
const ZIP_MAX_BYTES = 0xffff_ffff;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION_NEEDED = 20;
/** Made by Unix (3), spec 2.0: so the external attributes carry a mode. */
const VERSION_MADE_BY = (3 << 8) | 20;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** A regular file, rw-r--r--, in the high half as Unix zips put it. */
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

/** A finished archive: its parts in order, and their total length. */
export interface ZipArchive {
  readonly chunks: readonly Uint8Array[];
  readonly sizeBytes: number;
}

/**
 * The archive of `entries`, in the order given. Throws a RangeError past
 * what a non-ZIP64 archive can hold; callers cap well below that.
 */
export async function zip(entries: readonly ZipEntry[]): Promise<ZipArchive> {
  if (entries.length > ZIP_MAX_ENTRIES)
    throw new RangeError("Too many files for a ZIP archive.");
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.bytes);
    const deflated = await deflate(entry.bytes);
    const method =
      deflated.byteLength < entry.bytes.byteLength ? DEFLATED : STORED;
    const body = method === DEFLATED ? deflated : entry.bytes;
    if (
      entry.bytes.byteLength > ZIP_MAX_BYTES ||
      offset + 30 + name.byteLength + body.byteLength > ZIP_MAX_BYTES
    )
      throw new RangeError("Too large for a ZIP archive without ZIP64.");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.byteLength, 20);
    header.writeUInt32LE(entry.bytes.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    // Extra length, comment length, disk number, internal attributes: 0.
    header.writeUInt32LE(FILE_ATTRIBUTES, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (offset + centralSize + 22 > ZIP_MAX_BYTES)
    throw new RangeError("Too large for a ZIP archive without ZIP64.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  // This disk and the central directory's disk: 0.
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  chunks.push(...central, end);
  return { chunks, sizeBytes: offset + centralSize + end.byteLength };
}
