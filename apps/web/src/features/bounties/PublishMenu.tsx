/**
 * The way a version is published: every publication is made until a date,
 * so the button opens a choice of one rather than publishing outright.
 *
 * Quick actions, a menu of its own beside the popup (under its row on a
 * phone, where there is no room beside it), publish for a day, three or a
 * week from now. Under them a calendar publishes until the end
 * of the day picked. Either publishes at once; there is nothing else to
 * confirm.
 */

import { ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";

import { Calendar } from "@/components/Calendar";
import { DisabledReason } from "@/components/DisabledReason";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The quick actions: a publication this many days from now. */
export const QUICK_EXPIRY_DAYS = [1, 3, 7] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last moment of a day, local time: a date picked runs through it. */
function endOfDay(day: Date): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    23,
    59,
    59,
    999,
  );
}

function shortDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function PublishMenu({
  disabledReason,
  busy,
  onPublish,
}: {
  /** Why it cannot be published now; null when it can. */
  disabledReason: string | null;
  /** A publish or unpublish is in flight. */
  busy: boolean;
  /** Publish until this moment, an ISO time. */
  onPublish: (expiresAt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Read when the popup opens, so a quick action counts from then.
  const [now, setNow] = useState(() => new Date());
  // Beside the popup where the screen has room for it, under its row where not.
  const [beside, setBeside] = useState(true);
  const publish = (expiresAt: Date) => {
    setOpen(false);
    onPublish(expiresAt.toISOString());
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setNow(new Date());
          setBeside(
            typeof window.matchMedia !== "function" ||
              window.matchMedia("(min-width: 640px)").matches,
          );
        }
        setOpen(next);
      }}
    >
      <DisabledReason reason={disabledReason}>
        <Popover.Trigger asChild>
          <Button disabled={busy || disabledReason !== null}>Publish</Button>
        </Popover.Trigger>
      </DisabledReason>
      <Popover.Portal>
        <Popover.Content
          aria-label="Publish until"
          align="end"
          sideOffset={4}
          collisionPadding={16}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 flex w-72 max-w-(--radix-popover-content-available-width) origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-md border p-3 shadow-md outline-none"
        >
          <p className="text-muted-foreground text-xs">
            Publish until the date it expires.
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hover:bg-accent focus-visible:ring-ring/50 data-[state=open]:bg-accent -mx-2 flex items-center justify-between rounded-md px-2 py-1.5 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
              >
                Quick actions
                <ChevronRight className="text-muted-foreground size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={beside ? "right" : "bottom"}
              align={beside ? "start" : "end"}
              collisionPadding={16}
              className="min-w-40"
            >
              {QUICK_EXPIRY_DAYS.map((days) => {
                const until = new Date(now.getTime() + days * DAY_MS);
                return (
                  <DropdownMenuItem
                    key={days}
                    onSelect={() => publish(until)}
                    className="justify-between gap-4"
                  >
                    <span>{days === 1 ? "1 day" : `${days} days`}</span>
                    <span className="text-muted-foreground text-xs">
                      {shortDate(until)}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div aria-hidden="true" className="bg-border -mx-3 h-px" />
          <Calendar from={now} onSelect={(day) => publish(endOfDay(day))} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
