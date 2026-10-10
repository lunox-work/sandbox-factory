/**
 * shadcn's class helper, used by every generated component.
 *
 * `clsx` resolves conditionals and `tailwind-merge` drops the loser when two
 * classes set the same property — so a `className` passed by a caller beats
 * the component's own default instead of depending on stylesheet order.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale's own steps (`index.css`), told to tailwind-merge as font
 * sizes. Unregistered, `text-title` reads to it as a colour, and
 * `cn("text-title", "text-muted-foreground")` keeps only the colour.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "display", "title", "heading", "subheading"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
