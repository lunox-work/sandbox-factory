/**
 * The one definition of where an avatar lives: the object key it is stored
 * under, and the path it is served from, which is also what the picture
 * columns hold.
 *
 * Both Better Auth hooks and the avatar routes read this file, so the shape a
 * client may write and the shape the server writes cannot drift apart. Every
 * segment is validated before it becomes part of a key: no request string is
 * ever concatenated into one.
 */

export const AVATAR_KINDS = ["user", "organization"] as const;

/** Whose picture it is. A personal organization has none; see `routes.ts`. */
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** Where the API serves avatars. Under `/api/`, outside `/api/v1`. */
export const AVATAR_ROUTE_PREFIX = "/api/avatars";

/**
 * Account ids as Better Auth and `generateId` mint them: letters, digits,
 * `_` and `-`. Anything else is not an id this application issued.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A SHA-256 of the processed bytes, lowercase hex. */
const HASH = /^[0-9a-f]{64}$/;

/** The served path, anchored: nothing before it, nothing after it. */
const SERVED_PATH =
  /^\/api\/avatars\/(user|organization)\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{64})\.webp$/;

export interface AvatarRef {
  readonly kind: AvatarKind;
  readonly id: string;
  readonly hash: string;
}

/** Whether three untrusted segments name an avatar this API could hold. */
export function isAvatarRef(kind: string, id: string, hash: string): boolean {
  return (
    (AVATAR_KINDS as readonly string[]).includes(kind) &&
    ID.test(id) &&
    HASH.test(hash)
  );
}

function assertRef(ref: AvatarRef): void {
  if (!isAvatarRef(ref.kind, ref.id, ref.hash)) {
    throw new Error(`Not an avatar reference: ${JSON.stringify(ref)}`);
  }
}

/** The object key, e.g. `avatars/user/u_1/<hash>.webp`. */
export function objectKey(ref: AvatarRef): string {
  assertRef(ref);
  return `avatars/${ref.kind}/${ref.id}/${ref.hash}.webp`;
}

/**
 * The path the picture is served from and stored as. Relative: the web app
 * is same-origin with the API everywhere (Vite proxy, nginx, CloudFront).
 */
export function servedPath(ref: AvatarRef): string {
  assertRef(ref);
  return `${AVATAR_ROUTE_PREFIX}/${ref.kind}/${ref.id}/${ref.hash}.webp`;
}

/**
 * The avatar a stored picture value names, or undefined when it is not one of
 * ours — a provider's URL from signup, say, or null.
 */
export function parseServedPath(value: unknown): AvatarRef | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = SERVED_PATH.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, kind, id, hash] = match;
  return { kind: kind as AvatarKind, id: id ?? "", hash: hash ?? "" };
}

/**
 * Whether a client may write `value` into the picture column of `owner`:
 * null, to fall back to the identicon, or one of that same owner's own avatar
 * paths. A URL elsewhere, another account's avatar, or anything else is
 * refused — that is what makes the columns safe to render.
 */
export function admitsPicture(
  value: unknown,
  owner: { kind: AvatarKind; id: string },
): boolean {
  if (value === null) {
    return true;
  }
  const ref = parseServedPath(value);
  return ref !== undefined && ref.kind === owner.kind && ref.id === owner.id;
}
