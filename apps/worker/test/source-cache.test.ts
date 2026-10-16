import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSourceCache } from "../src/source-cache.js";

async function root() {
  return mkdtemp(join(tmpdir(), "source-cache-"));
}
/** A fill that writes one file of `bytes` and counts its calls. */
function filler(bytes = 10) {
  const calls: string[] = [];
  const fill = async (directory: string) => {
    calls.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    await writeFile(join(source, "a.ts"), "x".repeat(bytes));
    return source;
  };
  return { fill, calls };
}

test("a commit is filled once and read from disk after", async () => {
  const directory = await root();
  try {
    const cache = await createSourceCache({ root: directory });
    const { fill, calls } = filler();
    const first = await cache.checkout("ghr_1@a", fill);
    assert.equal(first.hit, false);
    assert.equal(
      await readFile(join(first.path, "a.ts"), "utf8"),
      "x".repeat(10),
    );
    first.release();
    first.release();
    const second = await cache.checkout("ghr_1@a", fill);
    assert.equal(second.hit, true);
    assert.equal(second.path, first.path);
    assert.equal(calls.length, 1);
    second.release();
    // Another commit is its own entry.
    const other = await cache.checkout("ghr_1@b", fill);
    assert.notEqual(other.path, first.path);
    assert.equal(calls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs asking for one commit while it fills share the fill", async () => {
  const directory = await root();
  try {
    const cache = await createSourceCache({ root: directory });
    const { fill, calls } = filler();
    const [a, b] = await Promise.all([
      cache.checkout("ghr_1@a", fill),
      cache.checkout("ghr_1@a", fill),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(a.path, b.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("past the bound the least recently used idle entry goes, never one in use", async () => {
  const directory = await root();
  let clock = 0;
  try {
    const cache = await createSourceCache({
      root: directory,
      maxBytes: 25,
      now: () => (clock += 1),
    });
    const { fill, calls } = filler(10);
    const a = await cache.checkout("a", fill);
    a.release();
    const b = await cache.checkout("b", fill);
    // `a` is read again, so `b` is now the older of the two idle ones.
    (await cache.checkout("a", fill)).release();
    b.release();
    // Held while a third arrives: 30 bytes, and only `b` may go.
    const held = await cache.checkout("a", fill);
    const c = await cache.checkout("c", fill);
    assert.equal(calls.length, 3);
    assert.equal((await cache.checkout("a", fill)).hit, true);
    assert.equal((await cache.checkout("b", fill)).hit, false);
    held.release();
    c.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run sharing a fill that fails for the filler's own reasons fills again", async () => {
  const directory = await root();
  try {
    const cache = await createSourceCache({ root: directory });
    // The first run's fill fails as its deadline or lease would cut it.
    let cut!: (error: Error) => void;
    let started!: () => void;
    const filling = new Promise<void>((resolve) => (started = resolve));
    const first = cache.checkout(
      "a",
      () =>
        new Promise<string>((_resolve, reject) => {
          cut = reject;
          started();
        }),
    );
    const { fill, calls } = filler();
    const second = cache.checkout("a", fill);
    await filling;
    cut(new Error("tool_timeout"));
    await assert.rejects(first, /tool_timeout/);
    const own = await second;
    assert.equal(own.hit, false);
    assert.equal(calls.length, 1);
    assert.equal(
      await readFile(join(own.path, "a.ts"), "utf8"),
      "x".repeat(10),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an entry a run takes while an eviction removes others is kept", async () => {
  const directory = await root();
  let clock = 0;
  let onNow: (() => void) | null = null;
  try {
    const cache = await createSourceCache({
      root: directory,
      maxBytes: 250,
      now: () => {
        const hook = onNow;
        onNow = null;
        hook?.();
        return (clock += 1);
      },
    });
    // `a` is many small files, so removing it spans several turns.
    const a = await cache.checkout("a", async (into) => {
      const source = join(into, "source");
      await mkdir(source);
      for (let index = 0; index < 200; index++)
        await writeFile(join(source, `f${index}.ts`), "x");
      return source;
    });
    a.release();
    const b = await cache.checkout("b", filler(10).fill);
    b.release();
    // `c` puts the cache past its bound by both idle entries; while `a` is
    // removed, a run takes `b`.
    let taken: Promise<{ path: string; release(): void }> | undefined;
    const c = await cache.checkout("c", async (into) => {
      const source = join(into, "source");
      await mkdir(source);
      await writeFile(join(source, "c.ts"), "x".repeat(245));
      onNow = () =>
        setImmediate(() => {
          taken = cache.checkout("b", filler(10).fill);
        });
      return source;
    });
    assert.ok(taken !== undefined);
    const held = await taken;
    assert.equal(held.path, b.path);
    assert.equal(
      await readFile(join(held.path, "a.ts"), "utf8"),
      "x".repeat(10),
    );
    held.release();
    c.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fill that fails leaves nothing, and the next run fills again", async () => {
  const directory = await root();
  try {
    const cache = await createSourceCache({ root: directory });
    await assert.rejects(
      cache.checkout("a", async (into) => {
        await writeFile(join(into, "partial"), "x");
        throw new Error("network");
      }),
      /network/,
    );
    assert.deepEqual(await readdir(directory), []);
    const { fill, calls } = filler();
    assert.equal((await cache.checkout("a", fill)).hit, false);
    assert.equal(calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restarted worker keeps complete entries and removes cut-short ones", async () => {
  const directory = await root();
  try {
    const before = await createSourceCache({ root: directory });
    const { fill, calls } = filler();
    (await before.checkout("a", fill)).release();
    // A fill the last worker never finished, and a stray file.
    await mkdir(join(directory, "cut-short"));
    await writeFile(join(directory, "cut-short", "half.ts"), "x");
    await mkdir(join(directory, "garbled"));
    await writeFile(join(directory, "garbled", "entry.json"), "{}");

    const after = await createSourceCache({ root: directory });
    const again = await after.checkout("a", fill);
    assert.equal(again.hit, true);
    assert.equal(calls.length, 1);
    assert.equal(
      await readFile(join(again.path, "a.ts"), "utf8"),
      "x".repeat(10),
    );
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
