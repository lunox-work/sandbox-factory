/**
 * Uploading and removing a picture, for a person or a team.
 *
 * Both endpoints answer `{ image }` on success and `{ error }` on a refusal,
 * so one pair of functions serves both, and both callers get a plain string
 * to show next to the picture that was refused.
 */

/** What the API accepts; mirrored so an obvious mismatch never leaves the page. */
export const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const MAX_BYTES = 5 * 1024 * 1024;

export const TOO_LARGE = "Pictures must be 5 MB or smaller.";
export const UNSUPPORTED = "Use a PNG, JPEG, WebP or GIF.";
/** The routes are unmounted when the server has no object storage. */
export const UPLOADS_OFF = "Picture uploads are not enabled on this server.";

export type AvatarResult = { image: string | null } | { error: string };

/**
 * The reason a file would be refused, checked before it is sent: a 20 MB
 * photo should not travel to the server to be told it is too big. An empty
 * `type` — some systems report none — is left for the server to decide.
 */
export function precheck(file: File): string | undefined {
  if (file.size > MAX_BYTES) {
    return TOO_LARGE;
  }
  if (
    file.type !== "" &&
    !(ACCEPTED_TYPES as readonly string[]).includes(file.type)
  ) {
    return UNSUPPORTED;
  }
  return undefined;
}

async function send(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<AvatarResult> {
  try {
    const res = await fetch(url, { ...init, credentials: "include" });
    if (res.status === 404) {
      return { error: UPLOADS_OFF };
    }
    const body = (await res.json().catch(() => null)) as {
      image?: unknown;
      error?: unknown;
    } | null;
    if (
      res.ok &&
      body !== null &&
      (typeof body.image === "string" || body.image === null)
    ) {
      return { image: body.image };
    }
    return { error: typeof body?.error === "string" ? body.error : fallback };
  } catch {
    return { error: fallback };
  }
}

/** `/api/v1/me/avatar` or `/api/v1/orgs/:id/avatar`. */
export async function uploadAvatar(
  url: string,
  file: File,
): Promise<AvatarResult> {
  const refused = precheck(file);
  if (refused !== undefined) {
    return { error: refused };
  }
  const form = new FormData();
  form.append("file", file);
  return await send(
    url,
    { method: "PUT", body: form },
    "Could not save that picture.",
  );
}

export async function removeAvatar(url: string): Promise<AvatarResult> {
  return await send(url, { method: "DELETE" }, "Could not remove the picture.");
}
