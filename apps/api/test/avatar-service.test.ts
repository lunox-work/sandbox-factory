import assert from "node:assert/strict";
import { test } from "node:test";

import type { ObjectStore } from "@sandbox-factory/db";

import { createAvatarService } from "../src/avatars/service.js";

const HASH = "d".repeat(64);

/** A `Map` behind the object-store contract, recording what was asked. */
function memoryStore(options: { failRemove?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  const removed: string[] = [];
  const store: ObjectStore = {
    put: (key, bytes, put) => {
      objects.set(key, {
        bytes,
        ...(put?.contentType === undefined ? {} : { type: put.contentType }),
      });
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(objects.get(key)?.bytes),
    exists: (key) => Promise.resolve(objects.has(key)),
    remove: (key) => {
      removed.push(key);
      if (options.failRemove === true) {
        return Promise.reject(new Error("storage down"));
      }
      objects.delete(key);
      return Promise.resolve();
    },
    signedUrl: () => Promise.reject(new Error("not used")),
  };
  return { store, objects, removed };
}

/** Stands in for sharp: every upload "processes" to the same bytes. */
const process = () =>
  Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), hash: HASH });

test("save stores the processed bytes as WebP and returns the served path", async () => {
  const { store, objects } = memoryStore();
  const service = createAvatarService({ store, process });

  const path = await service.save("user", "user_1", new Uint8Array([9]));

  assert.equal(path, `/api/avatars/user/user_1/${HASH}.webp`);
  const saved = objects.get(`avatars/user/user_1/${HASH}.webp`);
  assert.deepEqual(saved?.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(saved?.type, "image/webp");
});

test("a refused upload stores nothing", async () => {
  const { store, objects } = memoryStore();
  const service = createAvatarService({
    store,
    process: () => Promise.reject(new Error("refused")),
  });

  await assert.rejects(service.save("user", "user_1", new Uint8Array([9])));
  assert.equal(objects.size, 0);
});

test("read returns stored bytes, and undefined for an unknown avatar", async () => {
  const { store } = memoryStore();
  const service = createAvatarService({ store, process });
  await service.save("organization", "org_1", new Uint8Array([9]));

  assert.deepEqual(
    await service.read("organization", "org_1", HASH),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(await service.read("organization", "org_2", HASH), undefined);
});

test("discard deletes the replaced avatar's object", async () => {
  const { store, removed } = memoryStore();
  const service = createAvatarService({ store, process });

  await service.discard(`/api/avatars/user/user_1/${HASH}.webp`, null);

  assert.deepEqual(removed, [`avatars/user/user_1/${HASH}.webp`]);
});

test("discard leaves alone what is not ours, and what is still in place", async () => {
  const { store, removed } = memoryStore();
  const service = createAvatarService({ store, process });
  const current = `/api/avatars/user/user_1/${HASH}.webp`;

  // A provider picture from signup, nothing at all, and a re-upload of the
  // same picture, which landed on the same key.
  await service.discard("https://avatars.example/u/1.png", current);
  await service.discard(null, current);
  await service.discard(undefined, null);
  await service.discard(current, current);

  assert.deepEqual(removed, []);
});

test("a failed discard is logged, never thrown", async () => {
  const { store } = memoryStore({ failRemove: true });
  const logged: string[] = [];
  const service = createAvatarService({
    store,
    process,
    log: (message) => logged.push(message),
  });

  await assert.doesNotReject(
    service.discard(`/api/avatars/user/user_1/${HASH}.webp`, null),
  );
  assert.deepEqual(logged, ["Failed to delete a replaced avatar"]);
});

test("by default a failed discard goes to console.error", async () => {
  const { store } = memoryStore({ failRemove: true });
  const original = console.error;
  const seen: unknown[] = [];
  console.error = (...args: unknown[]) => seen.push(args[0]);
  try {
    await createAvatarService({ store, process }).discard(
      `/api/avatars/user/user_1/${HASH}.webp`,
      null,
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["Failed to delete a replaced avatar"]);
});
