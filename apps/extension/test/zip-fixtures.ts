import { deflateRawSync } from "node:zlib";

import { crc32 } from "../src/zip.js";

export const text = (value: string) => new TextEncoder().encode(value);

/** A one-entry archive with a chosen name, method and header fields. */
export function rawZip(
  entries: readonly {
    name: string;
    data?: Uint8Array;
    method?: number;
    flags?: number;
    mode?: number;
    declaredSize?: number;
  }[],
): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? text("x");
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(entry.declaredSize ?? data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    parts.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(data), 16);
    header.writeUInt32LE(body.byteLength, 20);
    header.writeUInt32LE(entry.declaredSize ?? data.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.byteLength + body.byteLength;
  }
  const size = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
