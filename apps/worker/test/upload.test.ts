import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { uploadArtifacts } from "../src/upload.js";
import { stores } from "./helpers.js";
import type { ArtifactFile } from "../src/tools/adapter.js";

/** `count` small files on disk, each holding its own index. */
async function files(directory: string, count: number) {
  const made: ArtifactFile[] = [];
  for (let index = 0; index < count; index++) {
    const absolutePath = join(directory, `f${index}`);
    await writeFile(absolutePath, String(index));
    made.push({
      path: `wiki/f${index}.md`,
      absolutePath,
      kind: "wiki_page",
      contentType: "text/plain",
      meta: null,
    });
  }
  return made;
}
const indexOf = (key: string) => Number(/f(\d+)\.md$/.exec(key)?.[1]);

test("uploads run eight at a time and answer in the files' order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-pool-"));
  try {
    const input = await files(directory, 20);
    const state = stores();
    let inFlight = 0;
    let most = 0;
    const finished: number[] = [];
    state.objects.putStream = async (key, body) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      for await (const chunk of body) void chunk;
      // Earlier files take longer, so they finish after later ones.
      await delay(20 - indexOf(key));
      finished.push(indexOf(key));
      inFlight -= 1;
    };
    const uploaded: string[] = [];
    const result = await uploadArtifacts(
      state.objects,
      "run",
      "lease",
      input,
      new AbortController().signal,
      uploaded,
    );
    assert.equal(most, 8);
    assert.notDeepEqual(
      finished,
      input.map((_file, index) => index),
    );
    assert.deepEqual(
      result.map((artifact) => artifact.path),
      input.map((file) => file.path),
    );
    assert.deepEqual(
      result.map((artifact) => artifact.objectKey),
      input.map((file) => `runs/run/lease/${file.path}`),
    );
    assert.equal(uploaded.length, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("after a failed upload none starts, those in flight finish, and it is thrown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-pool-fail-"));
  try {
    const input = await files(directory, 20);
    const state = stores();
    const started: number[] = [];
    const finished: number[] = [];
    let failedAt = -1;
    // The failure waits for all eight to reach the store: a worker that has
    // claimed its file may still be hashing it, and is in flight all the same.
    let allStarted: () => void = () => undefined;
    const eightStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    state.objects.putStream = async (key, body) => {
      const index = indexOf(key);
      started.push(index);
      if (started.length === 8) allStarted();
      for await (const chunk of body) void chunk;
      if (index === 2) {
        await eightStarted;
        failedAt = started.length;
        throw new Error("store offline");
      }
      await delay(15);
      finished.push(index);
    };
    const uploaded: string[] = [];
    await assert.rejects(
      uploadArtifacts(
        state.objects,
        "run",
        "lease",
        input,
        new AbortController().signal,
        uploaded,
      ),
      /store offline/,
    );
    // The first eight were in flight; none started after the failure.
    assert.deepEqual(
      [...started].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(started.length, failedAt);
    // The other seven finished before the failure was thrown.
    assert.deepEqual(
      [...finished].sort((a, b) => a - b),
      [0, 1, 3, 4, 5, 6, 7],
    );
    // Every key that may have been written is kept for the cleanup.
    assert.deepEqual(
      [...uploaded].sort(),
      started.map((index) => `runs/run/lease/wiki/f${index}.md`).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
