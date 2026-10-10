/**
 * One size as a card. The current size is the larger card, drawn solid; the
 * others are small and quiet, and become buttons when `onClick` is given.
 * Without it the card is a plain label, which is what a member or an
 * approved proposal sees: the size, without the offer to change it.
 *
 * A resize does not swap elements, it swaps classes on the same cards
 * once the server answers, so the change is animated rather than snapped:
 * the old size shrinks and fades to quiet while the new one grows and
 * fills, on one eased curve. Everything that differs between the two
 * shapes is in the transition list, so nothing jumps while the rest glides.
 * Off under reduced motion.
 *
 * Three things would make that bumpy, and each is kept out on purpose:
 *
 * - The width is never set, only the minimum. A set width lands on its new
 *   value at once while the minimum is still easing, so a growing card
 *   would pop wide and then finish growing. With only the minimum in play
 *   the box follows the ease in both directions, and "unsized" is free to
 *   be wider than it is tall.
 * - The other cards keep their look while the request is in flight. They
 *   are disabled, so a second click cannot race the first, but they are not
 *   dimmed and still answer the pointer: a dim would flash across the row
 *   on every click, and dropping the hover would make the pressed card
 *   fall back to quiet before it fills.
 * - The row is as tall as the large card whatever is mid-flight. Halfway
 *   through, the old card has shrunk and the new one has not yet grown,
 *   and without a floor the row would dip and lift the amount beside it.
 */
export function SizeCard({
  size,
  current,
  pressed = current,
  disabled,
  onClick,
}: {
  size: string;
  current: boolean;
  /** Whether the button stands for the size in force; the current one by default. */
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  // Square: the minimum width is the height, and the padding is small
  // enough that "XS" and "XL" fit inside it. "unsized" and a half size
  // such as "XS+" grow wider.
  const shape = current
    ? "bg-cta text-cta-foreground border-transparent h-12 min-w-12 px-2 text-lg font-bold shadow-xs"
    : "bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 h-7 min-w-7 px-1 text-xs";
  const className = `inline-flex items-center justify-center rounded-md border font-mono font-medium transition-[height,min-width,padding,font-size,font-weight,color,background-color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${shape}`;
  if (onClick === undefined) {
    return <span className={className}>{size}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.98] motion-reduce:active:scale-100`}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {size}
    </button>
  );
}
