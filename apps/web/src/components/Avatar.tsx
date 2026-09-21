/**
 * The avatar shown for a user or an organization: their picture if there is
 * one, and the identicon generated from their id if there is not.
 *
 * One component for both, because both appear in the same lists and two
 * fallback styles there would read as a bug. Extracted from `UserMenu`, which
 * kept it private while it was the only caller.
 */

import { Identicon } from "@/components/Identicon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Round for a person, rounded-square for an organization — the convention
 * everywhere this pattern appears, and the only thing distinguishing the two
 * kinds: the grid itself is generated the same way for both.
 *
 * A prop rather than a radius class at each organization call site, so
 * the choice is made once and cannot be forgotten at a new one.
 */
export type AvatarShape = "circle" | "square";

/**
 * `rounded-lg`, which is what the mark this replaced used and what the boxes
 * around it use. Not the shadcn default `rounded-full`, which would make an
 * organization look like a person.
 */
const SQUARE_RADIUS = "rounded-lg";

/**
 * How long the identicon waits before appearing, when there is a picture on
 * the way.
 *
 * Radix shows the fallback *while* the image loads, not only when it fails.
 * Initials flashing ahead of a photo was quiet; a saturated grid flashing on
 * every page load is not. With this, an account whose picture loads never
 * shows its identicon at all, and one whose URL is dead shows it a beat late.
 */
const FALLBACK_DELAY_MS = 400;

export function EntityAvatar({
  id,
  image,
  shape,
  className,
}: {
  /**
   * The account id — `user.id` or `organization.id`. Required: optional would
   * mean one entity quietly wearing two different faces on two screens, which
   * is worse than a type error.
   */
  id: string;
  image?: string | null;
  shape: AvatarShape;
  className?: string;
}) {
  // Null for an account with no picture, and `AvatarImage` expects a string,
  // so it is left out entirely rather than passed an empty src.
  const picture =
    image !== null && image !== undefined && image !== "" ? image : null;

  return (
    <Avatar className={cn(shape === "square" && SQUARE_RADIUS, className)}>
      {picture !== null && (
        <AvatarImage
          src={picture}
          alt=""
          // The provider's CDN does not need to know who is using this app.
          referrerPolicy="no-referrer"
        />
      )}
      {/*
        Radix keeps the fallback if the image errors, which is the case that
        matters: providers hand out avatar URLs that later 404.

        `rounded-[inherit]` because the fallback carries its own `rounded-full`
        — without it, squaring the root leaves a circle inside a rounded
        square.
      */}
      <AvatarFallback
        className="rounded-[inherit]"
        delayMs={picture !== null ? FALLBACK_DELAY_MS : undefined}
      >
        <Identicon seed={id} className="size-full" />
      </AvatarFallback>
    </Avatar>
  );
}
