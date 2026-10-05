/**
 * One part of a bounty's sandbox: its slice, and where successful
 * submissions are held. Each says what it is under its name, with anything
 * about it as a whole beside the name.
 */

import { useId, type ComponentType, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function SandboxCard({
  icon: Icon,
  iconClassName,
  title,
  description,
  action,
  children,
}: {
  /** A Lucide icon, or any drawn the same way: sized by `className`. */
  icon: ComponentType<{ className?: string }>;
  /** Its colour, when not the muted one icons beside a name take. */
  iconClassName?: string;
  title: string;
  description: string;
  /** Beside its name, on the right. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-2">
        {/* The row is the name's height whatever sits beside it: a taller
            control centres on the name and spills into the card's padding,
            so the description sits as close under every card's name. */}
        <div className="flex h-5 items-center justify-between gap-3">
          <h4
            id={id}
            className="flex min-w-0 items-center gap-2 text-sm font-medium"
          >
            <Icon
              className={cn(
                "text-muted-foreground size-4 shrink-0",
                iconClassName,
              )}
            />
            {title}
          </h4>
          {action}
        </div>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}
