/**
 * Why a control is disabled, shown in a tooltip when it is hovered or
 * focused. With no reason, the tooltip never opens.
 *
 * A disabled button takes no pointer events and no focus, so the tooltip
 * hangs on a span around it instead: the span is what is hovered, and it
 * takes focus in the button's place so a keyboard reaches the reason too.
 * The span stays when the reason goes, so the control is not remounted as
 * it is enabled and disabled.
 */

import type { ReactElement } from "react";

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
  return (
    <Tooltip {...(held ? {} : { open: false })}>
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
