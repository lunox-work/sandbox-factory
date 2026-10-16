/**
 * Extracted source kept on the worker's disk by repository and commit, so
 * the runs of one commit (its builders, a scope, a slice, a build) fetch
 * and unpack it once between them rather than once each.
 *
 * Bounded by bytes on disk: past the bound, the entries least recently
 * used go first, never one a run is reading. Entries survive a restart of
 * the worker on the same disk, each written beside a record of its size
 * once complete; a directory without one was cut short and is removed.
 *
 * A run reads its entry and never writes to it: every tool writes to its
 * own output directory, so the tree stays as it was extracted for the next
 * run of the commit.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

/** The bytes kept by default: room for a few large repositories. */
export const SOURCE_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

const RECORD = "entry.json";

export interface SourceCheckout {
  /** The extracted tree. */
  readonly path: string;
  /** Whether it was already on disk. */
  readonly hit: boolean;
  /** Lets the entry be evicted again; call once the run is done reading. */
  release(): void;
}

export interface SourceCache {
  /**
   * The tree under `key`, filled by `fill` into an empty directory when it
   * is not on disk. `fill` returns the tree's path inside that directory.
   * Two runs asking for one key while it fills share the one fill.
   */
  checkout(
    key: string,
    fill: (directory: string) => Promise<string>,
  ): Promise<SourceCheckout>;
}

interface Entry {
  readonly directory: string;
  path: string;
  bytes: number;
  users: number;
  lastUsed: number;
  ready: Promise<void>;
  complete: boolean;
}

export interface SourceCacheOptions {
  readonly root: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export async function createSourceCache(
  options: SourceCacheOptions,
): Promise<SourceCache> {
  const maxBytes = options.maxBytes ?? SOURCE_CACHE_BYTES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  await mkdir(options.root, { recursive: true });

  // What an earlier worker on this disk left complete is kept.
  for (const name of await readdir(options.root)) {
    const directory = join(options.root, name);
    try {
      const record = JSON.parse(
        await readFile(join(directory, RECORD), "utf8"),
      ) as { name?: unknown; path?: unknown; bytes?: unknown };
      if (
        typeof record.name !== "string" ||
        typeof record.path !== "string" ||
        typeof record.bytes !== "number" ||
        entries.has(record.name)
      )
        throw new Error("Not a complete entry.");
      entries.set(record.name, {
        directory,
        path: join(directory, record.path),
        bytes: record.bytes,
        users: 0,
        lastUsed: (await stat(join(directory, RECORD))).mtimeMs,
        ready: Promise.resolve(),
        complete: true,
      });
    } catch {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const evict = async () => {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    const idle = [...entries]
      .filter(([, entry]) => entry.complete && entry.users === 0)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [name, entry] of idle) {
      if (total <= maxBytes) break;
      entries.delete(name);
      total -= entry.bytes;
      await rm(entry.directory, { recursive: true, force: true });
    }
  };
  await evict();

  return {
    async checkout(key, fill) {
      const name = createHash("sha256").update(key).digest("hex").slice(0, 40);
      let entry = entries.get(name);
      const hit = entry !== undefined;
      if (entry === undefined) {
        // Its own directory, so an eviction of an earlier fill of the same
        // key still being removed cannot remove this one's files.
        const directory = join(options.root, `${name}-${randomUUID()}`);
        const created: Entry = {
          directory,
          path: directory,
          bytes: 0,
          users: 0,
          lastUsed: now(),
          ready: Promise.resolve(),
          complete: false,
        };
        created.ready = (async () => {
          try {
            await mkdir(directory, { recursive: true });
            const path = await fill(directory);
            created.bytes = await sizeOf(directory);
            created.path = path;
            await writeFile(
              join(directory, RECORD),
              JSON.stringify({
                name,
                path: relative(directory, path),
                bytes: created.bytes,
              }),
            );
            created.complete = true;
          } catch (error) {
            // A fill that fails leaves nothing for the next run to read.
            if (entries.get(name) === created) entries.delete(name);
            await rm(directory, { recursive: true, force: true });
            throw error;
          }
        })();
        entries.set(name, created);
        entry = created;
      }
      entry.users += 1;
      try {
        await entry.ready;
      } catch (error) {
        entry.users -= 1;
        throw error;
      }
      entry.lastUsed = now();
      await evict();
      const held = entry;
      let released = false;
      return {
        path: held.path,
        hit,
        release() {
          if (released) return;
          released = true;
          held.users -= 1;
          held.lastUsed = now();
          void evict().catch(() => {});
        },
      };
    },
  };
}

/** The bytes of every file under a directory. */
async function sizeOf(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile())
      bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return bytes;
}
