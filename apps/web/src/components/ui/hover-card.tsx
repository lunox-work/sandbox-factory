/**
 * shadcn/ui hover card (new-york), on the `radix-ui` package the app already
 * carries: a preview that opens while the pointer rests on its trigger.
 *
 * Radix keeps it to sighted pointer users, so whatever it previews must also
 * be reachable another way, by the click its trigger already answers.
 */

import { HoverCard as HoverCardPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function HoverCard({
  openDelay = 250,
  closeDelay = 80,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 max-w-[calc(100vw-2rem)] origin-(--radix-hover-card-content-transform-origin) rounded-lg border p-3 text-xs shadow-lg outline-hidden motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
