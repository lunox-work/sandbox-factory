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

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
}: {
  /** The control that opens this. Rendered as the trigger itself, not wrapped. */
  trigger: ReactNode;
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
  onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  // Cleared on the way in and out, so a dialog opened, abandoned, and opened
  // again does not come back holding a half-typed handle from last time.
  useEffect(() => {
    if (!open) {
      setTyped("");
    }
  }, [open]);

  const satisfied =
    typeToConfirm === undefined || typed.trim() === typeToConfirm;

  async function confirm() {
    // Closed first, so the dialog does not sit over the page while a request
    // runs and the row it belonged to disappears underneath it. The page below
    // owns the outcome: every caller reports failures in its own error banner.
    setOpen(false);
    await onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/*
        `asChild`, so the caller's own button is the trigger rather than a
        button wrapping one — which would be invalid markup, and would drop one
        of the two from the accessibility tree.
      */}
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {typeToConfirm !== undefined && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              Type <strong>{typeToConfirm}</strong> to confirm.
            </p>
            <Input
              // The label the delete tests already look this input up by.
              aria-label="Type the handle to confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              // The field is the point of this variant, so it takes the focus
              // rather than the cancel button.
              autoFocus
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
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
            disabled={busy || !satisfied}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
