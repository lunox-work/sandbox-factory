/**
 * The three ways a page speaks back: a banner when something failed, a line
 * under a form when something was saved, and a line while something is still
 * being read.
 *
 * All three markups existed already, repeated verbatim — the banner at the top
 * of four screens, the saved line under two forms, the loading line in nine
 * places and in three different shapes. Extracted rather than replaced with
 * shadcn's `Alert`, which carries a title, a description and an icon slot that
 * none of these callers fill: the styling here is what the app already looks
 * like.
 */

import { Loader2 } from "lucide-react";

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
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * The rest reaches the element, so a caller can keep the `data-testid` its
   * own tests already look it up by.
   */
} & React.ComponentProps<"p">) {
  return (
    <p
      role="alert"
      className={cn(
        "text-destructive border-destructive/35 bg-destructive/7 mt-6 rounded-lg border px-3 py-2.5 text-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}

/**
 * A read that has not answered yet.
 *
 * One shape everywhere, because the app had three: a bare "Loading…", a
 * spinner beside the word, and — on the members list — nothing at all, so an
 * organization looked briefly as though it had no members. A moving spinner is
 * what distinguishes "still working" from "finished, and this is the answer".
 *
 * `role="status"` rather than `alert`: a screen reader should mention it when
 * the reader is idle, not interrupt to say a list is still arriving. The
 * spinner is `aria-hidden`, or it would be announced as an image beside the
 * word it illustrates.
 */
export function LoadingLine({
  children = "Loading…",
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "text-muted-foreground flex items-center gap-2 text-sm",
        className,
      )}
    >
      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
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
