import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchSource } from "../src/fetch-source.js";
import { AnalysisError, CommandError } from "../src/errors.js";
import { run } from "./helpers.js";
const signal = new AbortController().signal;
const code = (wanted: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === wanted;
async function fixture() {
  return mkdtemp(join(tmpdir(), "source-fetch-"));
}
function fetcher(response: Response) {
  const calls: RequestInit[] = [];
  const fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location: "https://codeload.github.com/acme/widgets/tar.gz/sha",
          },
        })
      : response;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
test("archive redirect strips credentials and streams bytes before extraction", async () => {
  const directory = await fixture();
  const { fetch, calls } = fetcher(new Response("archive"));
  const commands: readonly string[][] = [];
  try {
    const source = await fetchSource(run, directory, {
      maxBytes: 5000,
      maxFiles: 5,
      signal,
      token: async () => "secret",
      fetch,
      execute: async (_cmd, args) => {
        (commands as string[][]).push([...args]);
        return "";
      },
    });
    assert.equal(source, join(directory, "source"));
    assert.equal(
      await readFile(join(directory, "source.tar.gz"), "utf8"),
      "archive",
    );
    assert.equal(
      (calls[0]?.headers as Record<string, string>)["Authorization"],
      "Bearer secret",
    );
    assert.equal(calls[0]?.redirect, "manual");
    assert.equal(calls[1]?.headers, undefined);
    assert.equal(calls[1]?.redirect, "error");
    assert.equal(commands[0]?.at(-2), "5");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("size metadata, content length, and a stream exceeding the cap fail fast", async () => {
  const directory = await fixture();
  try {
    await assert.rejects(
      fetchSource(run, directory, {
        maxBytes: 1,
        maxFiles: 5,
        signal,
        token: async () => "x",
      }),
      code("too_large"),
    );
    for (const response of [
      new Response("oversized", { headers: { "content-length": "100" } }),
      new Response("oversized"),
    ]) {
      await assert.rejects(
        fetchSource({ ...run, sizeKb: null }, directory, {
          maxBytes: 4,
          maxFiles: 5,
          signal,
          token: async () => "x",
          fetch: fetcher(response).fetch,
        }),
        code("too_large"),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("redirect hosts, credentials, statuses, and malformed source identities are refused", async () => {
  const directory = await fixture();
  try {
    for (const location of [
      "http://codeload.github.com/a",
      "https://evil.test/a",
      "https://user:pass@codeload.github.com/a",
    ]) {
      const fetch = (async () =>
        new Response(null, {
          status: 302,
          headers: { location },
        })) as typeof globalThis.fetch;
      await assert.rejects(
        fetchSource(run, directory, {
          maxBytes: 5000,
          maxFiles: 5,
          signal,
          token: async () => "x",
          fetch,
        }),
        code("source_unavailable"),
      );
    }
    for (const status of [200, 404])
      await assert.rejects(
        fetchSource(run, directory, {
          maxBytes: 5000,
          maxFiles: 5,
          signal,
          token: async () => "x",
          fetch: (async () =>
            new Response(null, { status })) as typeof globalThis.fetch,
        }),
        code("source_unavailable"),
      );
    await assert.rejects(
      fetchSource({ ...run, commitSha: "bad" }, directory, {
        maxBytes: 5000,
        maxFiles: 5,
        signal,
        token: async () => "x",
      }),
      code("source_unavailable"),
    );
    await assert.rejects(
      fetchSource(run, directory, {
        maxBytes: 5000,
        maxFiles: 5,
        signal,
        token: async () => "x",
        fetch: fetcher(new Response(null, { status: 404 })).fetch,
      }),
      code("source_unavailable"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("extractor errors retain bounded public error codes", async () => {
  const directory = await fixture();
  try {
    for (const [exit, wanted] of [
      [2, "too_large"],
      [3, "too_many_files"],
      [4, "source_unavailable"],
    ] as const) {
      await assert.rejects(
        fetchSource(run, directory, {
          maxBytes: 5000,
          maxFiles: 5,
          signal,
          token: async () => "x",
          fetch: fetcher(new Response("archive")).fetch,
          execute: async () => {
            throw new CommandError(exit);
          },
        }),
        code(wanted),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("the download and the unpacking are timed apart, a failed unpacking too", async () => {
  const directory = await fixture();
  try {
    for (const fails of [false, true]) {
      const stages: [string, number][] = [];
      let ticks = 0;
      const fetched = fetchSource(run, directory, {
        maxBytes: 5000,
        maxFiles: 5,
        signal,
        token: async () => "x",
        fetch: fetcher(new Response("archive")).fetch,
        execute: async () => {
          if (fails) throw new CommandError(4);
          return "";
        },
        // Every reading of the clock is 5 ms after the last.
        clock: () => (ticks += 5),
        onStage: (stage, ms) => stages.push([stage, ms]),
      });
      if (fails) await assert.rejects(fetched, code("source_unavailable"));
      else await fetched;
      assert.deepEqual(stages, [
        ["fetch", 5],
        ["extract", 5],
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("the bucket's copy is read before GitHub, and GitHub's is kept once it unpacks", async () => {
  const directory = await fixture();
  try {
    const execute = async () => "";
    // Kept: GitHub is not asked.
    const kept = fetcher(new Response("unused"));
    const writes: number[] = [];
    await fetchSource(run, directory, {
      maxBytes: 5000,
      maxFiles: 5,
      signal,
      token: async () => "x",
      fetch: kept.fetch,
      execute,
      archive: {
        read: async () => new TextEncoder().encode("from the bucket"),
        write: async (_path, bytes) => {
          writes.push(bytes);
        },
      },
    });
    assert.equal(kept.calls.length, 0);
    assert.deepEqual(writes, []);
    assert.equal(
      await readFile(join(directory, "source.tar.gz"), "utf8"),
      "from the bucket",
    );

    // Absent, unreadable or past the cap: GitHub's is read, then kept.
    for (const read of [
      async () => undefined,
      async () => {
        throw new Error("bucket down");
      },
      async () => new Uint8Array(6000),
    ]) {
      const github = fetcher(new Response("archive"));
      const stored: [string, number][] = [];
      await fetchSource(run, directory, {
        maxBytes: 5000,
        maxFiles: 5,
        signal,
        token: async () => "x",
        fetch: github.fetch,
        execute,
        archive: {
          read,
          write: async (path, bytes) => {
            stored.push([await readFile(path, "utf8"), bytes]);
          },
        },
      });
      assert.equal(github.calls.length, 2);
      assert.deepEqual(stored, [["archive", 7]]);
    }

    // One that does not unpack is not kept, and a failed write is no failure.
    const unpacked = { write: 0 };
    await assert.rejects(
      fetchSource(run, directory, {
        maxBytes: 5000,
        maxFiles: 5,
        signal,
        token: async () => "x",
        fetch: fetcher(new Response("archive")).fetch,
        execute: async () => {
          throw new CommandError(4);
        },
        archive: {
          read: async () => undefined,
          write: async () => {
            unpacked.write += 1;
          },
        },
      }),
      code("source_unavailable"),
    );
    assert.equal(unpacked.write, 0);
    await fetchSource(run, directory, {
      maxBytes: 5000,
      maxFiles: 5,
      signal,
      token: async () => "x",
      fetch: fetcher(new Response("archive")).fetch,
      execute,
      archive: {
        read: async () => undefined,
        write: async () => {
          throw new Error("bucket down");
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
