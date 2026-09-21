/**
 * A record opened over the list it came from, rather than beside it.
 *
 * The pattern Notion uses for a row in a database: the list stays where it
 * was, the record slides in from the right over a dimmed page, and closing it
 * returns you to exactly the row you were on. It suits a backlog better than
 * the two-column split it replaces, for three reasons.
 *
 * The split gave each side half the width, so a spec with a table in it had
 * about 400px to render in while the list beside it showed thirty rows of
 * truncated summaries — both cramped, to show two things at once that are not
 * read at once. A peek gives the ticket real width and leaves the list
 * legible behind it.
 *
 * It also settles which region the wheel belongs to. The split had the panel
 * pinned inside the page's own scroller, so a panel with its own overflow
 * captured the wheel when the cursor was inside it; without one, a long
 * ticket stretched the page. A peek is its own scrolling region with the page
 * behind it locked, which is unambiguous in a way neither arrangement was.
 *
 * And it is the same shape on a phone, where the split had to collapse into
 * one column and hide the list — a second layout to reason about, with a
 * bespoke "All tickets" control to undo it.
 *
 * Built on Radix's Dialog rather than hand-rolled, which is what brings the
 * focus trap, the return of focus to the row on close, Escape, the click
 * outside, and `aria-modal` wiring. `ui/dialog.tsx` is a generated file kept
 * as upstream ships it, so the sheet positioning lives here instead of as a
 * variant there.
 */

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function PeekPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Names the panel and appears in its fixed header above the scrolling body.
   */
  title: string;
  /** The same, for the sentence under the title. Optional. */
  description?: string | undefined;
  children: ReactNode;
  /** Pinned to the foot, outside the scrolling region. */
  footer?: ReactNode | undefined;
  className?: string;
} & { "data-testid"?: string }) {
  /*
    Where focus goes when this closes.

    Radix returns focus to its own `Trigger`, and there is none here: the peek
    is opened by a row in a list somewhere else in the tree, not by a button
    wrapping it. Left alone, closing drops focus on `<body>`, and a keyboard
    reader who peeks one ticket loses their place in the backlog entirely.

    So the element that had focus when the peek opened is remembered and
    restored on close — which is the row that opened it, and where the reader
    was. Guarded on it still being in the document: a row can be removed while
    the panel is open, and focusing a detached node throws.
  */
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/*
          Dimmed and blurred, as the app's own dialog overlay is: on a
          near-black theme a plain `bg-black/50` over a black page is almost
          invisible, and the blur is what separates the two planes.
        */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />

        <DialogPrimitive.Content
          className={cn(
            // A sheet against the right edge, full height. Wide enough for a
            // spec with a table in it, and capped so it does not become a
            // full-width page on a large monitor.
            "bg-background fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-lg outline-none sm:max-w-xl lg:max-w-2xl",
            // In from the edge it is attached to, which is what says where it
            // came from and where closing it will put it back.
            "data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:animate-none",
            className,
          )}
          // The row that opened it, rather than Radix's default of a trigger
          // that does not exist here. See `openerRef`.
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current;
            if (opener !== null && document.contains(opener)) {
              event.preventDefault();
              opener.focus();
            }
          }}
          {...rest}
        >
          <header className="bg-background flex min-h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-sm font-semibold break-words">
                {title}
              </DialogPrimitive.Title>
              {description !== undefined && (
                <DialogPrimitive.Description className="text-muted-foreground line-clamp-2 text-xs break-words">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="ring-offset-background focus-visible:ring-ring text-muted-foreground hover:bg-accent hover:text-foreground grid size-10 shrink-0 place-items-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {/*
            The only scrolling region on screen while this is open: Radix
            locks the page behind it, so the wheel has one destination
            wherever the cursor is.
          */}
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6 sm:py-5">
            {children}
          </div>

          {footer !== undefined && (
            <div className="bg-background border-t px-5 py-3 sm:px-6">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
