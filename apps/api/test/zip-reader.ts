import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";

/**
 * Reads a ZIP the way an unzipper does, from its end record and central
 * directory, independently of the writer: each entry's name and bytes,
 * its CRC checked.
 */
export function unzip(bytes: Uint8Array): { name: string; bytes: Buffer }[] {
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries: { name: string; bytes: Buffer }[] = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, size, name);
    assert.equal(crc32(data), crc, name);
    entries.push({ name, bytes: data });
    at += 46 + nameLength + skip;
  }
  return entries;
}
