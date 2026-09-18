/**
 * shadcn's class helper, used by every generated component.
 *
 * `clsx` resolves conditionals and `tailwind-merge` drops the loser when two
 * classes set the same property — so a `className` passed by a caller beats
 * the component's own default instead of depending on stylesheet order.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
