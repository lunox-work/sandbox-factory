/**
 * Avatar routes: one sessionless read, and an upload and a removal for each
 * kind of owner.
 *
 *   GET    /api/avatars/:kind/:id/:hash.webp   anyone; immutable
 *   PUT    /api/v1/me/avatar                   the caller
 *   DELETE /api/v1/me/avatar                   the caller
 *   PUT    /api/v1/orgs/:orgId/avatar          an owner or admin of a team
 *   DELETE /api/v1/orgs/:orgId/avatar          an owner or admin of a team
 *
 * The read has no session because member lists and the switcher show other
 * people's pictures, and because its URL is unguessable without the picture:
 * the last segment is a SHA-256 of the content. Provider pictures in
 * `user.image` are public URLs already, so this exposes nothing new.
 *
 * The writes are mounted after the session guard, and the organization pair
 * after the membership guard, by `createApp`.
 */

import type { OrganizationStore, UserProfileStore } from "@sandbox-factory/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { Auth } from "../auth.js";
import type { AuthVariables } from "../routes.js";
import { rankAtLeast } from "../routes.js";
import { MAX_UPLOAD_BYTES, UnsupportedImageError } from "./image.js";
import { isAvatarRef, type AvatarKind } from "./keys.js";
import { AVATAR_CONTENT_TYPE, type AvatarService } from "./service.js";

type AppEnv = { Variables: AuthVariables };

export interface AvatarRouteOptions {
  readonly avatars: AvatarService;
}

/** Headroom for the multipart envelope around a file at the cap. */
const MULTIPART_OVERHEAD = 64 * 1024;

export const TOO_LARGE = "Pictures must be 5 MB or smaller.";
export const NO_FILE = "Choose a picture to upload.";
export const PERSONAL_PICTURE =
  "A personal workspace wears your picture. Change it in Account settings.";
export const NOT_AN_ADMIN =
  "Only an owner or an admin can change the workspace’s picture.";

/** A year, immutable: the URL changes whenever the picture does. */
const CACHE_FOREVER = "public, max-age=31536000, immutable";

/** The sessionless read. Safe to mount anywhere; it matches nothing else. */
export function mountAvatarReadRoute(
  app: Hono<AppEnv>,
  { avatars }: AvatarRouteOptions,
): void {
  app.get("/api/avatars/:kind/:id/:file", async (c) => {
    const { kind, id, file } = c.req.param();
    const hash = file.endsWith(".webp") ? file.slice(0, -".webp".length) : "";
    // Validated before the store sees any of it.
    if (!isAvatarRef(kind, id, hash)) {
      return c.json({ error: "Not found." }, 404);
    }
    const bytes = await avatars.read(kind as AvatarKind, id, hash);
    if (bytes === undefined) {
      return c.json({ error: "Not found." }, 404);
    }
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": AVATAR_CONTENT_TYPE,
      "Cache-Control": CACHE_FOREVER,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
  });
}

/** The body limit for the two uploads, answering in this API's shape. */
const uploadLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD,
  onError: (c) => c.json({ error: TOO_LARGE }, 413),
});

/**
 * The uploaded file's bytes, or a response refusing the request. One field,
 * `file`, holding a file rather than a string.
 */
async function readUpload(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: NO_FILE }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: NO_FILE }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: TOO_LARGE }, 413);
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** Saves an upload, mapping a refused file to a 400. */
async function save(
  c: Context<AppEnv>,
  avatars: AvatarService,
  kind: AvatarKind,
  id: string,
): Promise<string | Response> {
  const upload = await readUpload(c);
  if (upload instanceof Response) {
    return upload;
  }
  try {
    return await avatars.save(kind, id, upload);
  } catch (error) {
    if (error instanceof UnsupportedImageError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
}

/**
 * The caller's own picture. Written through Better Auth rather than the
 * profile store because its update re-issues the session cookie: the
 * cookie cache the rail reads from carries the new picture at once instead
 * of up to five minutes later. The `/update-user` hook in `auth.ts` checks
 * this value like any client's, and admits it because it is the caller's own
 * avatar path.
 */
export function mountUserAvatarRoutes(
  app: Hono<AppEnv>,
  {
    avatars,
    auth,
    profiles,
  }: AvatarRouteOptions & {
    auth: Auth;
    profiles: Pick<UserProfileStore, "image">;
  },
): void {
  async function setImage(c: Context<AppEnv>, image: string | null) {
    const result = await auth.api.updateUser({
      headers: c.req.raw.headers,
      body: { image },
      returnHeaders: true,
    });
    // The refreshed session cookie, so `useSession()` sees the change.
    for (const cookie of result.headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }
  }

  app.put("/api/v1/me/avatar", uploadLimit, async (c) => {
    const userId = c.get("user").id;
    const saved = await save(c, avatars, "user", userId);
    if (saved instanceof Response) {
      return saved;
    }
    const previous = await profiles.image(userId);
    await setImage(c, saved);
    await avatars.discard(previous, saved);
    return c.json({ image: saved });
  });

  app.delete("/api/v1/me/avatar", async (c) => {
    const previous = await profiles.image(c.get("user").id);
    await setImage(c, null);
    await avatars.discard(previous, null);
    return c.json({ image: null });
  });
}

/**
 * A team's picture. Behind the membership guard, which has already turned a
 * non-member into a 404. A member below admin is told why rather than 404'd:
 * they can see the workspace, so its existence is no secret from them, and
 * the plugin answers its own member-only writes with a 403 too.
 */
export function mountOrganizationAvatarRoutes(
  app: Hono<AppEnv>,
  {
    avatars,
    organizations,
  }: AvatarRouteOptions & {
    organizations: Pick<OrganizationStore, "get" | "setLogo">;
  },
): void {
  /** The organization, or a response refusing the caller. */
  async function editable(c: Context<AppEnv>) {
    const { organizationId, role } = c.get("member");
    const found = await organizations.get(organizationId);
    if (found === undefined) {
      return c.json({ error: "Not found." }, 404);
    }
    if (found.kind === "personal") {
      return c.json(
        { error: PERSONAL_PICTURE, code: "PERSONAL_ORGANIZATION" },
        403,
      );
    }
    if (!rankAtLeast(role, "admin")) {
      return c.json({ error: NOT_AN_ADMIN }, 403);
    }
    return found;
  }

  app.put("/api/v1/orgs/:orgId/avatar", uploadLimit, async (c) => {
    const found = await editable(c);
    if (found instanceof Response) {
      return found;
    }
    const saved = await save(c, avatars, "organization", found.id);
    if (saved instanceof Response) {
      return saved;
    }
    await organizations.setLogo(found.id, saved);
    await avatars.discard(found.image, saved);
    return c.json({ image: saved });
  });

  app.delete("/api/v1/orgs/:orgId/avatar", async (c) => {
    const found = await editable(c);
    if (found instanceof Response) {
      return found;
    }
    await organizations.setLogo(found.id, null);
    await avatars.discard(found.image, null);
    return c.json({ image: null });
  });
}
