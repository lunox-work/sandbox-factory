/**
 * The Lunox code mark from brand/svg/logo-gradient.svg, drawn in the current
 * color so it sits in a button, or beside the slice's name, like any other
 * icon; the gradient would fight the button's fill. Decorative: the label
 * beside it says what it is.
 */
export function LunoxMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      fill="none"
      stroke="currentColor"
      strokeWidth={56}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M48 168 148 256 48 342" />
      <path d="M300 118 230 394" />
      <path d="M464 168 364 256 464 342" />
    </svg>
  );
}
