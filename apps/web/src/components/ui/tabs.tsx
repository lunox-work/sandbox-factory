/**
 * Tabs, on Radix's primitive. Started as shadcn's (new-york) and since made
 * the app's own: no track around the tabs, just one thumb that slides under
 * the chosen tab, rather than each tab painting its own background and the
 * choice snapping from one to the next.
 *
 * The `line` variant draws the thumb as a bar on a rule across the whole
 * width: tabs that head the column under them, as a page's sections do,
 * where pills would read as a control floating above it.
 */

import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

/** Where the thumb sits: the chosen trigger's box, inside the list. */
type Thumb = { x: number; y: number; width: number; height: number };

/**
 * Follows the chosen trigger. Radix marks it with `data-state="active"`, so
 * the list watches for that attribute rather than taking the value through
 * context — it works whether the tabs are controlled or not. A resize is
 * watched too, because a trigger can change width after it is chosen (a
 * count arriving beside its label) and the thumb has to change with it.
 */
function useThumb(list: React.RefObject<HTMLDivElement | null>) {
  const [thumb, setThumb] = React.useState<Thumb | null>(null);

  React.useLayoutEffect(() => {
    const node = list.current;
    if (node === null) return;

    const measure = () => {
      const active = node.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]',
      );
      setThumb(
        active === null
          ? null
          : {
              x: active.offsetLeft,
              y: active.offsetTop,
              width: active.offsetWidth,
              height: active.offsetHeight,
            },
      );
    };
    measure();

    const mutations = new MutationObserver(measure);
    mutations.observe(node, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-state"],
    });
    // jsdom has no ResizeObserver; the thumb still follows the choice there.
    const resizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizes?.observe(node);
    for (const trigger of node.querySelectorAll('[data-slot="tabs-trigger"]')) {
      resizes?.observe(trigger);
    }
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, [list]);

  return thumb;
}

/**
 * The thumb lands where it belongs on the first paint, then glides from
 * there on. Without this it would slide in from the list's corner every time
 * a page opened.
 */
function useSettled(thumb: Thumb | null) {
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (thumb === null || settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [thumb, settled]);
  return settled;
}

function TabsList({
  className,
  children,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  /**
   * `plain` drops the thumb, for a strip that draws its own
   * (the connections rail's folder tabs). `line` makes it a bar on a rule.
   */
  variant?: "default" | "line" | "plain";
}) {
  const list = React.useRef<HTMLDivElement>(null);
  const thumb = useThumb(list);
  const settled = useSettled(thumb);
  const line = variant === "line";
  const thumbed = variant !== "plain";

  return (
    <TabsPrimitive.List
      ref={list}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "group/tabs",
        variant === "default" &&
          "text-muted-foreground bg-muted relative inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg p-[3px]",
        // The rule is an inset shadow, not a border, so the bar can sit on
        // it inside the list's box. Hung a pixel below onto a border, the bar
        // overflowed the list, and a list that scrolls sideways (overflow-x
        // makes y scroll too) drew a scrollbar for that one pixel.
        line &&
          "text-muted-foreground relative flex h-10 w-full items-stretch gap-5 shadow-[inset_0_-1px_0_var(--border)]",
        !thumbed && "inline-flex w-fit items-center",
        className,
      )}
      {...props}
    >
      {thumbed && (
        <span
          aria-hidden="true"
          data-slot="tabs-thumb"
          className={cn(
            "pointer-events-none absolute left-0",
            // The bar is ink, as the active label is: the one choice on the
            // rule reads as chosen by weight, not by colour. The pill is a
            // raised face on a sunken track, as a segmented control is drawn.
            line
              ? "bg-foreground bottom-0 h-0.5 rounded-full"
              : "bg-background ring-border/60 dark:bg-input/40 top-0 rounded-md shadow-xs ring-1",
            settled &&
              "transition-[transform,width,height,opacity] duration-380 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          )}
          style={{
            opacity: thumb === null ? 0 : 1,
            width: thumb?.width ?? 0,
            // A bar keeps its own height, on the rule.
            height: line ? undefined : (thumb?.height ?? 0),
            transform: `translate3d(${thumb?.x ?? 0}px, ${line ? 0 : (thumb?.y ?? 0)}px, 0)`,
          }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // Above the thumb, which comes first in the list. No background of
        // its own: the thumb is what says which one is chosen.
        "text-muted-foreground hover:text-foreground data-[state=active]:text-foreground relative z-10 inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap select-none",
        "transition-[color,scale] duration-200 ease-out active:scale-[0.97] motion-reduce:transition-none",
        "focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // On a rule, as wide as its label, which the bar underlines.
        "group-data-[variant=line]/tabs:flex-none group-data-[variant=line]/tabs:rounded-sm group-data-[variant=line]/tabs:px-0.5",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        // Plays on every switch: a new panel is mounted, a `forceMount`ed one
        // comes back from `hidden`, and either restarts the animation. From
        // half opacity, not zero, and short: the old panel is gone the same
        // frame, so a fade from nothing left the space under the tabs blank
        // for a beat and the switch read as a flicker.
        "animate-in fade-in-50 flex-1 duration-150 ease-out outline-none motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
