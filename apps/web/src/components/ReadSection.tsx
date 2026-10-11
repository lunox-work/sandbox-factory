/**
 * The pieces a proposal's long read is built from: a section's heading,
 * and the card that holds what a model said.
 */

import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A section of a bounty step's page: its name over a rule, then what it
 * holds on the page itself, not in a card. A step's version is its one
 * card; the scope's text and links are headed so, and the price's and the
 * sandbox's parts are too. What the section adds up to, or the one action
 * on it, sits at the rule's right end.
 */
export function RuledSection({
  title,
  aside,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  aside?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("flex flex-col gap-3", className)}
      {...props}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b pb-2">
        <h3 id={id} className="eyebrow">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * A section's heading: a small tile wearing the section's icon, then its
 * title, and at the right edge what the section adds up to. The title is
 * an element of its own, so it reads, and is found, as just the title.
 *
 * `tone="model"` wears the brand gradient: the section is a model's word,
 * not a count the rubric made.
 */
export function SectionHeading({
  icon,
  id,
  aside,
  tone = "plain",
  className,
  children,
}: {
  icon: ReactNode;
  id?: string;
  aside?: ReactNode;
  tone?: "plain" | "model";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-2.5 flex items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-[6px] [&>svg]:size-3.5",
          tone === "model"
            ? "bg-(image:--brand-gradient) text-white shadow-sm shadow-blue-500/20"
            : "bg-muted text-muted-foreground border",
        )}
      >
        {icon}
      </span>
      <p id={id} className="text-subheading">
        {children}
      </p>
      {aside !== undefined && (
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {aside}
        </span>
      )}
    </div>
  );
}

/**
 * A card for what a model said: a hairline of the brand gradient along its
 * top and a faint glow in its corner, so a model's reasoning is told apart
 * from the rubric's arithmetic at a glance.
 */
export function ModelCard({
  as: Box = "div",
  className,
  children,
  ...props
}: ComponentProps<"div"> & { as?: "div" | "section" }) {
  return (
    <Box
      className={cn(
        "bg-card relative overflow-hidden rounded-xl border p-4 sm:p-5",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-(image:--brand-gradient) opacity-80"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-20 -right-20 size-48 rounded-full bg-(image:--brand-gradient) opacity-[0.07] blur-3xl"
      />
      <div className="relative">{children}</div>
    </Box>
  );
}
