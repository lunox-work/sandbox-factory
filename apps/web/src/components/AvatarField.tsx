/**
 * The avatar beside a handle editor, on the account and organization settings
 * pages, and the way into replacing it.
 *
 * The picture sits next to the handle rather than in a card of its own because
 * the two are the same fact: what this account is called and what it looks
 * like.
 *
 * Replacing it is the picture itself rather than a button beside it: a labelled
 * control would sit between the avatar and the field it belongs to, and the
 * picture is the thing being changed. An overlay on hover is the convention
 * everywhere this pattern appears, and it keeps the row the height of the
 * avatar.
 */

import { Pencil } from "lucide-react";

import { EntityAvatar, type AvatarShape } from "@/components/Avatar";
import { cn } from "@/lib/utils";

/**
 * Why the control does nothing yet.
 *
 * A `title` rather than body copy, following the "only way to sign in" control
 * on the account page: a sentence under every settings card explaining a thing
 * that does not exist yet is noise.
 */
const UPLOAD_UNAVAILABLE = "Uploading a picture is not available yet.";

export function AvatarField({
  id,
  image,
  shape,
  label,
}: {
  /** The account id. Permanent, and what the generated picture is drawn from. */
  id: string;
  image?: string | null;
  shape: AvatarShape;
  /** Names what the picture belongs to, for assistive technology. */
  label: string;
}) {
  return (
    /*
     * A `button` rather than a div with an overlay: this is a control, so it
     * is reachable by keyboard and announces itself. Disabled, because there
     * is no endpoint behind it yet — `disabled:` variants below are what keep
     * it from looking live while it is not.
     *
     * `group` drives the overlay: the pencil is keyed off hover and focus on
     * this element, not on the avatar inside it.
     */
    <button
      type="button"
      disabled
      title={UPLOAD_UNAVAILABLE}
      aria-label={`Change ${label} picture`}
      className={cn(
        "group focus-visible:ring-ring/50 relative shrink-0 cursor-pointer focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-default",
        // The root carries the shape so the scrim's `rounded-[inherit]` picks
        // it up. Left as `rounded-full`, a square avatar would get a circular
        // scrim over a rounded square.
        shape === "square" ? "rounded-lg" : "rounded-full",
      )}
    >
      {/*
        `size-16`: large enough that the 5x5 grid reads as a mark rather than
        as texture, which it does at the 24px the rail uses. This is the one
        place the picture is the subject rather than a label.
      */}
      <EntityAvatar id={id} image={image} shape={shape} className="size-16" />

      {/*
        Covers the picture rather than sitting in a corner of it: at 64px a
        badge would be too small to read as an affordance, and the scrim is
        what says the whole picture is the target.

        `rounded-[inherit]` so it follows the avatar's shape — the root is
        `rounded-full`, and an organization overrides it to `rounded-lg`.
      */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Pencil className="size-5" strokeWidth={1.8} />
      </span>
    </button>
  );
}
