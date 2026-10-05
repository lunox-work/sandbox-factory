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
 * read at once. A peek gives the bounty real width and leaves the list
 * legible behind it.
 *
 * It also settles which region the wheel belongs to. The split had the panel
 * pinned inside the page's own scroller, so a panel with its own overflow
 * captured the wheel when the cursor was inside it; without one, a long
 * bounty stretched the page. A peek is its own scrolling region with the page
 * behind it locked, which is unambiguous in a way neither arrangement was.
 *
 * And it is the same shape on a phone, where the split had to collapse into
 * one column and hide the list — a second layout to reason about, with a
 * bespoke "All bounties" control to undo it.
 *
 * A list a reader moves through, as the bounties are, opens it with `modal`
 * off, as Notion's side peek is: the list stays sharp and live beside it, a
 * click on another of its rows (marked `data-peek-row`) shows that row in the
 * same panel rather than closing it, and a click anywhere else still closes
 * it. The page behind is neither dimmed nor locked, so the list scrolls on
 * its own.
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

/** An icon control in the peek's header, as Close is drawn. */
export const PEEK_ACTION_CLASS =
  "ring-offset-background focus-visible:ring-ring text-muted-foreground hover:bg-accent hover:text-foreground grid size-10 shrink-0 place-items-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

/** Marks a row whose click shows it in an open, non-modal peek. */
export const PEEK_ROW_ATTRIBUTE = "data-peek-row";

/** Whether an interaction outside the peek landed on one of its rows. */
function onPeekRow(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(`[${PEEK_ROW_ATTRIBUTE}]`) !== null
  );
}

export function PeekPanel({
  open,
  onOpenChange,
  modal = true,
  title,
  titleHidden = false,
  description,
  children,
  actions,
  footer,
  className,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Over a dimmed, locked page, as a dialog is; or, when false, beside a
   * list that stays live, whose rows switch what it shows. Defaults to true.
   */
  modal?: boolean;
  /**
   * Names the panel and appears in its fixed header above the scrolling body.
   */
  title: string;
  /**
   * Names the panel without showing it, for a body that shows the title
   * itself, as a record renamed in place does.
   */
  titleHidden?: boolean;
  /** The same, for the sentence under the title. Optional. */
  description?: string | undefined;
  children: ReactNode;
  /**
   * Controls at the head of the header, opposite Close, such as opening the
   * record as a page of its own — where Notion's peek puts it. Sized and
   * styled by the caller; `PEEK_ACTION_CLASS` matches Close.
   */
  actions?: ReactNode | undefined;
  /** Pinned to the foot, outside the scrolling region. */
  footer?: ReactNode | undefined;
  className?: string;
} & { "data-testid"?: string }) {
  /*
    Where focus goes when this closes.

    Radix returns focus to its own `Trigger`, and there is none here: the peek
    is opened by a row in a list somewhere else in the tree, not by a button
    wrapping it. Left alone, closing drops focus on `<body>`, and a keyboard
    reader who peeks one bounty loses their place in the backlog entirely.

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

  /*
    Where focus goes when this opens.

    Radix's default is the first focusable thing inside, which here is the
    close button — so every peek opened with a focus ring drawn around the
    one control that undoes the open. The body takes it instead: it is what
    the reader came for, it scrolls with the keyboard from there, and Tab
    reaches the tabs and the close in order.
  */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        {/*
          Dimmed and blurred, as the app's own dialog overlay is: on a
          near-black theme a plain `bg-black/50` over a black page is almost
          invisible, and the blur is what separates the two planes. Radix
          draws none when the peek is not modal.
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
          onOpenAutoFocus={(event) => {
            if (bodyRef.current !== null) {
              event.preventDefault();
              bodyRef.current.focus({ preventScroll: true });
            }
          }}
          // A field edited in place takes its own Escape, to put back what
          // it held, rather than closing the panel around it.
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-own-escape]") !== null
            ) {
              event.preventDefault();
            }
          }}
          // Not modal: a click on another row shows it here rather than
          // closing the peek, and focus leaving for the list, as Tab does,
          // leaves it open. Any other click outside closes it.
          onPointerDownOutside={(event) => {
            if (!modal && onPeekRow(event.target)) event.preventDefault();
          }}
          onFocusOutside={(event) => {
            if (!modal) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current;
            if (opener !== null && document.contains(opener)) {
              event.preventDefault();
              opener.focus();
            }
          }}
          {...rest}
        >
          {/*
            Inset as the body is, with the icon controls at either end pulled
            out by their own padding, so the glyphs rather than the hit areas
            line up with the text below.
          */}
          <header className="bg-background flex min-h-14 shrink-0 items-center gap-1 border-b px-5 sm:px-6">
            {actions !== undefined && (
              <div className="-ml-3 flex shrink-0 items-center gap-1">
                {actions}
              </div>
            )}
            <div className="mx-2 min-w-0 flex-1 first:ml-0">
              <DialogPrimitive.Title
                className={cn(
                  "text-sm font-semibold break-words",
                  titleHidden && "sr-only",
                )}
              >
                {title}
              </DialogPrimitive.Title>
              {description !== undefined && (
                <DialogPrimitive.Description className="text-muted-foreground line-clamp-2 text-xs break-words">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className={cn(PEEK_ACTION_CLASS, "-mr-3")}
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {/*
            Its own scrolling region. A modal peek is the only one on screen,
            as Radix locks the page behind it; beside a live list, each
            scrolls under the cursor.
          */}
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none sm:px-6 sm:py-5"
          >
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
