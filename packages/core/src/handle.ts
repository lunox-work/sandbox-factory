/**
 * Public handles: the renameable name a user or an organization is known by.
 *
 * Both principals share these rules, and both keep a permanent id beside the
 * handle — `user.id` / `user.username`, `organization.id` / `organization.slug`
 * — so a rename never invalidates a reference.
 *
 * The rules live here, in the dependency-free package, because four places
 * need them and only this one is importable by all of them: the profile store
 * (`packages/db`), the organization hooks (`apps/api`), the wire schemas
 * (`packages/shared`), and both handle forms in the browser (`apps/web`), so a
 * name can be checked before a round trip.
 *
 * Deliberately narrow — lowercase letters, digits, hyphen, underscore — so a
 * handle works in a URL, a mention or a slug without escaping.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

const HANDLE_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Why a handle was refused, or `null` when it is fine. A reason string rather
 * than a boolean: every caller shows it to the person who typed the name.
 */
export type HandleProblem = "length" | "charset";

export interface HandleRejected {
  readonly status: "invalid";
  readonly problem: HandleProblem;
  /** Ready to show. The API and both forms use this wording verbatim. */
  readonly reason: string;
}

export type HandleCheck = { readonly status: "ok" } | HandleRejected;

/**
 * The stored form of a handle: trimmed and lowercased. Says nothing about
 * validity — pass the result to {@link checkHandle}, or use
 * {@link normalizeHandle}, which does both.
 */
export function toHandleCase(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether `handle` is usable, assuming it is already in stored form. Callers
 * with raw input should use {@link normalizeHandle}.
 */
export function checkHandle(handle: string): HandleCheck {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) {
    return {
      status: "invalid",
      problem: "length",
      reason: `Must be between ${HANDLE_MIN_LENGTH} and ${HANDLE_MAX_LENGTH} characters.`,
    };
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return {
      status: "invalid",
      problem: "charset",
      reason: "Can use letters, numbers, hyphens and underscores only.",
    };
  }
  return { status: "ok" };
}

export type NormalizedHandle =
  | { readonly status: "ok"; readonly handle: string; readonly display: string }
  | HandleRejected;

/**
 * Trims, lowercases and validates in one step.
 *
 * `display` keeps the casing that was typed, for surfaces that show a handle
 * back the way its owner writes it (`user.displayUsername`). `handle` is what
 * is stored and compared.
 */
export function normalizeHandle(raw: string): NormalizedHandle {
  const display = raw.trim();
  const handle = display.toLowerCase();
  const checked = checkHandle(handle);
  if (checked.status === "invalid") {
    return checked;
  }
  return { status: "ok", handle, display };
}

/** Whether `raw` would be accepted. For enabling a submit button. */
export function isValidHandle(raw: string): boolean {
  return normalizeHandle(raw).status === "ok";
}

/**
 * Strips leading and trailing hyphens in linear time. Do not simplify to
 * `replace(/^-+|-+$/g, "")`: that is quadratic on a long run of hyphens, and
 * the input is provider-supplied.
 */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * A handle stem derived from arbitrary text: an email address, an
 * organization name. Disallowed characters become hyphens, and the result is
 * trimmed to the maximum length.
 *
 * The result always passes {@link checkHandle}, including for text that
 * reduces to nothing (`"---"`, `"!!!"`, `""`), which the `-user` padding
 * carries over the minimum length. That matters because `suggest` hands a
 * stem straight to a rename path that would otherwise refuse it. It is still
 * only a *proposal*: it says nothing about whether the name is free.
 */
export function toHandleStem(text: string): string {
  const cleaned = trimHyphens(
    text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  ).slice(0, HANDLE_MAX_LENGTH);
  // Pad a too-short stem: "jo@example.com" must still produce a usable name.
  return cleaned.length >= HANDLE_MIN_LENGTH ? cleaned : `${cleaned}-user`;
}

/**
 * A handle stem from an email address. Uses the local part only: the domain
 * says where someone works, not who they are.
 */
export function handleStemFromEmail(email: string): string {
  return toHandleStem(email.split("@")[0] ?? "user");
}
