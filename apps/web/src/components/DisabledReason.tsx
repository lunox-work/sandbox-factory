/**
 * Why a control is disabled, shown in a tooltip when it is hovered or
 * focused. With no reason, the tooltip never opens.
 *
 * A disabled button takes no pointer events and no focus, so the tooltip
 * hangs on a span around it instead: the span is what is hovered, and it
 * takes focus in the button's place so a keyboard reaches the reason too.
 * The span stays when the reason goes, so the control is not remounted as
 * it is enabled and disabled. The tooltip is held open or shut by this
 * component throughout, so a reason that comes and goes never switches it
 * between controlled and uncontrolled.
 */

import { useState, type ReactElement } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function DisabledReason({
  reason,
  children,
}: {
  /** Why it is disabled; null when it is not, or when no reason is owed. */
  reason: string | null;
  children: ReactElement;
}) {
  const held = reason !== null;
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={held && open}
      // Only while held: a hover with nothing to say would leave `open` set,
      // and the tooltip would pop up later with no pointer on it.
      onOpenChange={(next) => setOpen(held && next)}
    >
      <TooltipTrigger asChild>
        <span
          tabIndex={held ? 0 : undefined}
          className={
            held
              ? "focus-visible:ring-ring/50 inline-flex w-fit cursor-not-allowed rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
              : "inline-flex w-fit"
          }
        >
          {children}
        </span>
      </TooltipTrigger>
      {held && <TooltipContent>{reason}</TooltipContent>}
    </Tooltip>
  );
}
