/**
 * The two ways a page speaks back: a banner when something failed, and a line
 * under a form when something was saved.
 *
 * Both markups existed already, repeated verbatim — the banner at the top of
 * four screens, the line under two forms. Extracted rather than replaced with
 * shadcn's `Alert`, which carries a title, a description and an icon slot that
 * none of these callers fill: the styling here is what the app already looks
 * like.
 */

import { cn } from "@/lib/utils";

/**
 * A failure at the top of a screen — the load that did not return, the save
 * the server refused.
 *
 * `role="alert"` because it appears in response to something the reader just
 * did, and a screen reader should say so without being asked. Rendered only
 * when there is something to say, so the role is never announced empty.
 */
export function ErrorBanner({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "text-destructive border-destructive/35 bg-destructive/7 mt-6 rounded-lg border px-3 py-2.5 text-sm",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * The outcome of a form the reader submitted, under the form itself.
 *
 * `role="status"` rather than `alert`: this is the quieter half of the pair,
 * announced politely once the reader is idle. "Saved." interrupting what
 * somebody is typing next would be worse than saying it a moment late.
 *
 * `failed` carries the colour rather than a second component, because the
 * message occupies the same line either way — a rename that was refused
 * replaces "Saved." in place.
 */
export function FormStatus({
  failed,
  children,
  className,
}: {
  failed: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "mt-2 text-sm",
        failed ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
