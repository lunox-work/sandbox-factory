/**
 * The way a version is published: every publication is made until a date,
 * so the button opens a choice of one rather than publishing outright.
 *
 * The menu publishes for a day, three or a week from now. "Set a date" in
 * it closes the menu and opens a calendar in its place, which publishes
 * until the end of the day picked. Either publishes at once; there is
 * nothing else to confirm.
 *
 * The calendar is a popup of its own rather than a part of the menu: a
 * menu takes the arrow keys and Tab for its items, which a grid of days
 * needs for itself.
 */

import { ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { useRef, useState } from "react";

import { Calendar } from "@/components/Calendar";
import { DisabledReason } from "@/components/DisabledReason";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The menu's choices: a publication this many days from now. */
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Read when the menu opens, so a choice counts from then.
  const [now, setNow] = useState(() => new Date());
  /*
    Set when "Set a date" closes the menu. The calendar opens once the menu
    has closed, not as it closes: until then the menu holds the focus to
    itself, and the calendar, losing it, would close again at once.
  */
  const toCalendar = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const publish = (expiresAt: Date) => {
    setMenuOpen(false);
    setCalendarOpen(false);
    onPublish(expiresAt.toISOString());
  };

  return (
    <Popover.Root open={calendarOpen} onOpenChange={setCalendarOpen}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) setNow(new Date());
          setMenuOpen(next);
        }}
      >
        <DisabledReason reason={disabledReason}>
          <Popover.Anchor asChild>
            <DropdownMenuTrigger asChild>
              <Button ref={button} disabled={busy || disabledReason !== null}>
                Publish
              </Button>
            </DropdownMenuTrigger>
          </Popover.Anchor>
        </DisabledReason>
        <DropdownMenuContent
          align="end"
          collisionPadding={16}
          className="min-w-48"
          onCloseAutoFocus={(event) => {
            if (!toCalendar.current) return;
            toCalendar.current = false;
            event.preventDefault();
            setCalendarOpen(true);
          }}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Publish for
          </DropdownMenuLabel>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              toCalendar.current = true;
            }}
            className="justify-between gap-4"
          >
            Set a date
            <ChevronRight />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover.Portal>
        <Popover.Content
          aria-label="Publish until"
          align="end"
          sideOffset={4}
          collisionPadding={16}
          // With no trigger of its own, focus goes back to Publish.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            button.current?.focus();
          }}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 flex w-72 max-w-(--radix-popover-content-available-width) origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-md border p-3 shadow-md outline-none"
        >
          <p className="text-muted-foreground text-xs">
            Publish until the end of the day you pick.
          </p>
          <Calendar from={now} onSelect={(day) => publish(endOfDay(day))} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
