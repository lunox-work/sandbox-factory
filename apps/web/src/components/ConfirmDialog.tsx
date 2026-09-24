/**
 * The question asked before something that cannot be taken back.
 *
 * Four actions in this app give away access or destroy data: disconnecting a
 * site, removing a member, leaving an organization, deleting one. Only the
 * last of them used to ask — the other three fired on a single click, beside
 * rows of near-identical names, which is exactly how the wrong one gets
 * pressed. And the one that did ask expanded inline underneath an unrelated
 * button, so "Type acme to confirm" appeared to be confirming a different
 * action from the one it belonged to.
 *
 * One component for all four, so the weight of a question matches the weight
 * of what it is asking about, rather than each call site deciding for itself.
 *
 * `typeToConfirm` is the second gear: for deleting an organization, a click on
 * "yes" is not enough, and the handle has to be typed. Everything else takes a
 * plain confirm — the cost of an accidental leave is an invitation, while the
 * cost of an accidental delete is everything the organization owns.
 *
 * Signing out is deliberately not here. It costs one click to undo, so a
 * dialog would be an obstacle rather than a safeguard.
 */

import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  tone = "destructive",
  typeToConfirm,
  busy = false,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: {
  /**
   * The control that opens this. Rendered as the trigger itself, not wrapped.
   * Absent when the question is opened from a menu item: the menu closes as
   * the item is chosen, taking any trigger inside it along.
   */
  trigger?: ReactNode;
  title: string;
  description: ReactNode;
  /** What the confirming button says. Names the act, never "OK". */
  confirmLabel: string;
  /**
   * `danger` is the brand red kept for deleting an organization; see the token
   * note in `index.css`. Everything else is the ordinary destructive red.
   */
  tone?: "destructive" | "danger";
  /**
   * When set, the confirm stays disabled until this exact string is typed.
   * For deleting an organization, which takes every member's access with it.
   */
  typeToConfirm?: string | undefined;
  /** A write is in flight somewhere on the page. */
  busy?: boolean | undefined;
  onConfirm: () => void | string | Promise<void | string>;
  /** Held by the caller instead, for a dialog opened without a trigger. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cleared on the way in and out, so a dialog opened, abandoned, and opened
  // again does not come back holding a half-typed handle from last time.
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  const satisfied =
    typeToConfirm === undefined || typed.trim() === typeToConfirm;

  async function confirm() {
    if (pending || busy || !satisfied) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const failure = await onConfirm();
      if (typeof failure === "string") {
        setError(failure);
        return;
      }
      setOpen(false);
    } catch {
      setError("That did not work. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      {/*
        `asChild`, so the caller's own button is the trigger rather than a
        button wrapping one — which would be invalid markup, and would drop one
        of the two from the accessibility tree.
      */}
      {trigger !== undefined && (
        <AlertDialogPrimitive.Trigger asChild>
          {trigger}
        </AlertDialogPrimitive.Trigger>
      )}

      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <AlertDialogPrimitive.Content
          className="bg-background fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-5 shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none sm:max-w-md sm:p-6"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (typeToConfirm === undefined) {
              cancelRef.current?.focus();
            } else {
              inputRef.current?.focus();
            }
          }}
        >
          <div className="flex flex-col gap-2 text-center sm:text-left">
            <AlertDialogPrimitive.Title className="text-lg leading-none font-semibold">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="text-muted-foreground text-sm">
              {description}
            </AlertDialogPrimitive.Description>
          </div>

          {typeToConfirm !== undefined && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                Type <strong>{typeToConfirm}</strong> to confirm.
              </p>
              <Input
                ref={inputRef}
                // The label the delete tests already look this input up by.
                aria-label="Type the handle to confirm"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                // The field is the point of this variant, so it takes the focus
                // rather than the cancel button.
                disabled={pending || busy}
              />
            </div>
          )}

          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button
                ref={cancelRef}
                type="button"
                variant="ghost"
                disabled={busy || pending}
              >
                Cancel
              </Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button
                type="button"
                variant="destructive"
                /*
              `variant="destructive"` for the shape and the focus ring,
              repainted in the brand red for the one action that uses it. The
              ring has to be repainted too, or it stays the old red against the
              new fill.
            */
                className={
                  tone === "danger"
                    ? "bg-danger text-danger-foreground hover:bg-danger/90 focus-visible:ring-danger/20"
                    : undefined
                }
                disabled={busy || pending || !satisfied}
                onClick={(event) => {
                  event.preventDefault();
                  void confirm();
                }}
              >
                {pending
                  ? `${confirmLabel.endsWith("e") ? confirmLabel.slice(0, -1) : confirmLabel}ing…`
                  : confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
