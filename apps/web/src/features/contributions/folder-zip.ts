/**
 * A project folder picked or dropped in the browser, zipped for upload:
 * the same archive a contributor would make by hand, so the API reads one
 * format (`POST …/submissions/zip`) and compares it with the version in
 * one place. Entries are stored, not deflated: a project without its
 * `node_modules/` is small, and stored entries need only a CRC-32.
 *
 * What the API would skip unread (`skippedName`: `node_modules/`, `.git/`,
 * OS files) is skipped here before a byte is read, so picking a folder
 * that was installed costs nothing for it.
 */

import { SUBMISSION_ZIP_MAX_BYTES } from "@sandbox-factory/shared";
import { skippedName } from "sandbox-factory";

/** One file of the folder, at its path under the folder's own name. */
export interface FolderEntry {
  readonly path: string;
  readonly file: Blob;
}

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

const UTF8_NAMES = 0x0800;
const DOS_DATE = (1 << 5) | 1;

/** The folder's files as one stored ZIP, everything at its own path. */
export async function zipEntries(
  entries: readonly FolderEntry[],
): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let size = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.byteLength, true);
    local.setUint32(22, bytes.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    parts.push(local.buffer, name, bytes);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, (3 << 8) | 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, UTF8_NAMES, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, bytes.byteLength, true);
    header.setUint32(24, bytes.byteLength, true);
    header.setUint16(28, name.byteLength, true);
    header.setUint32(38, (0o100644 << 16) >>> 0, true);
    header.setUint32(42, offset, true);
    central.push(header.buffer, name);
    size += 46 + name.byteLength;
    offset += 30 + name.byteLength + bytes.byteLength;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], {
    type: "application/zip",
  });
}

/** Why a folder cannot be zipped for upload; null when it can. */
export function folderProblem(entries: readonly FolderEntry[]): string | null {
  if (entries.length === 0)
    return "The folder holds no files besides node_modules and .git.";
  if (entries.length >= 0xffff)
    return "The folder holds too many files. Pick the downloaded project folder.";
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  return total > SUBMISSION_ZIP_MAX_BYTES
    ? "The folder is too large to upload. Pick the downloaded project folder."
    : null;
}

/** The files an `<input webkitdirectory>` picked, `node_modules/` and the like left out. */
export function pickedEntries(files: Iterable<File>): FolderEntry[] {
  const entries: FolderEntry[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!skippedName(path)) entries.push({ path, file });
  }
  return entries;
}

/**
 * The files of a dropped folder, read through the entries API, never
 * descending into what `skippedName` skips.
 */
export async function droppedEntries(
  root: FileSystemEntry,
): Promise<FolderEntry[]> {
  const entries: FolderEntry[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    const path = entry.fullPath.replace(/^\/+/, "");
    if (skippedName(path)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      entries.push({ path, file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // `readEntries` answers in batches until it answers none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child);
    }
  };
  await walk(root);
  return entries;
}
