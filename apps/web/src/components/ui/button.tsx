/**
 * shadcn/ui button (new-york). Generated component, kept as upstream ships
 * it so a later `shadcn add` diff stays readable, with two departures.
 *
 * The default variant is `--cta`: ink on the light theme, the brand's blue on
 * the dark one. It is the one control on a screen that asks to be pressed,
 * and a solid neutral says so without competing with the content. On a dark
 * page ink would be a white slab, so there it takes the blue instead. It used
 * to wear the brand's gradient, which put the loudest colour on the page on
 * every Save.
 *
 * Only while it can be pressed. Disabled — blocked on a setup step, an empty
 * field, a save in flight — it turns the neutral grey of a control that is
 * not on offer, rather than fading the blue: a dimmed call to action still
 * reads as the thing to press next.
 *
 * And it is a step denser: 32px tall where upstream is 36px, matching the
 * 13px body copy it sits beside.
 */

import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,border-color,box-shadow,opacity,transform,filter] duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring aria-invalid:ring-destructive/20 aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-cta text-cta-foreground shadow-xs hover:bg-cta/85 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        sm: "h-7 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2",
        lg: "h-9 rounded-md px-5 has-[>svg]:px-4",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
