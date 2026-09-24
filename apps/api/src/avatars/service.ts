/**
 * Avatar objects in storage: processing and saving an upload, reading one
 * back, and discarding the one it replaced.
 *
 * Knows nothing about who may do what or which column holds the result —
 * that is the routes' business. It only guarantees that every key it touches
 * was built by `keys.ts`.
 */

import type { ObjectStore } from "@sandbox-factory/db";

import { processImage, type ProcessedAvatar } from "./image.js";
import {
  objectKey,
  parseServedPath,
  servedPath,
  type AvatarKind,
} from "./keys.js";

export interface AvatarService {
  /**
   * Processes an upload and stores it. Resolves to the served path, which is
   * what the picture column should hold. Throws `UnsupportedImageError` for
   * input it refuses, before anything is stored.
   */
  save(kind: AvatarKind, id: string, upload: Uint8Array): Promise<string>;
  /** The stored bytes, or undefined when there is no such avatar. */
  read(
    kind: AvatarKind,
    id: string,
    hash: string,
  ): Promise<Uint8Array | undefined>;
  /**
   * Deletes the object a replaced picture value pointed at, if it was one of
   * ours and is not the value now in place. A provider URL or null is left
   * alone. Never throws: the column already moved on, and an orphaned object
   * costs a few kilobytes, whereas failing the request would report a change
   * that in fact happened.
   */
  discard(
    previous: string | null | undefined,
    current: string | null,
  ): Promise<void>;
}

export interface AvatarServiceOptions {
  readonly store: ObjectStore;
  /** Swappable for tests; `processImage` in production. */
  readonly process?: (input: Uint8Array) => Promise<ProcessedAvatar>;
  /** Where a failed discard is reported. `console.error` by default. */
  readonly log?: (message: string, error: unknown) => void;
}

export const AVATAR_CONTENT_TYPE = "image/webp";

export function createAvatarService({
  store,
  process = processImage,
  log = (message, error) => console.error(message, error),
}: AvatarServiceOptions): AvatarService {
  return {
    async save(kind, id, upload) {
      const { bytes, hash } = await process(upload);
      const ref = { kind, id, hash };
      await store.put(objectKey(ref), bytes, {
        contentType: AVATAR_CONTENT_TYPE,
      });
      return servedPath(ref);
    },

    async read(kind, id, hash) {
      return await store.get(objectKey({ kind, id, hash }));
    },

    async discard(previous, current) {
      if (previous === current) {
        // The same picture uploaded again lands on the same key.
        return;
      }
      const ref = parseServedPath(previous);
      if (ref === undefined) {
        return;
      }
      try {
        await store.remove(objectKey(ref));
      } catch (error) {
        log("Failed to delete a replaced avatar", error);
      }
    },
  };
}
