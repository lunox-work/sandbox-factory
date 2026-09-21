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
 * What a click says, until there is somewhere to put a picture.
 *
 * Exported so the pages render the same sentence and the tests assert it
 * rather than a copy of it.
 */
export const UPLOAD_COMING_SOON =
  "Uploading your own picture is coming soon — for now it is generated from your account ID, which never changes.";

export function AvatarField({
  id,
  image,
  shape,
  label,
  onEdit,
}: {
  /** The account id. Permanent, and what the generated picture is drawn from. */
  id: string;
  image?: string | null;
  shape: AvatarShape;
  /** Names what the picture belongs to, for assistive technology. */
  label: string;
  /**
   * Called when the picture is clicked.
   *
   * The message goes under the form, where this card already reports "Saved."
   * after a rename, so the page owns it rather than this component: a 64px
   * column has nowhere to put a sentence.
   */
  onEdit: () => void;
}) {
  return (
    /*
     * Enabled, not disabled. A disabled button swallows the click silently —
     * no event, and the `title` that used to carry the reason never appears on
     * a touch screen and never for a keyboard. Answering the click is what
     * makes the control honest: it is not broken, it is not built yet.
     *
     * `group` drives the overlay: the pencil is keyed off hover and focus on
     * this element, not on the avatar inside it.
     */
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Change ${label} picture`}
      className={cn(
        "group focus-visible:ring-ring/50 relative shrink-0 focus-visible:ring-[3px] focus-visible:outline-none",
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

        `rounded-[inherit]` so it follows the avatar's shape.
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
