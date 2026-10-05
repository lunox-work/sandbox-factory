/**
 * The app's one way to pick a value from a list.
 *
 * A trigger that reads like a field opens a popover: a search field over the
 * options. Typing narrows the list, never enters a value of its own; the
 * arrow keys walk what is left, Enter takes the highlighted option and
 * Escape closes. Typing on the closed trigger opens it with that keystroke
 * already in the search, so nobody has to open it first.
 *
 * It replaced three ways of doing the same job: native `<select>`s, whose
 * menu is the operating system's and whose caret sits wherever the browser
 * puts it; a Radix `Select`, which cannot be searched; and dropdown menus
 * pressed into service as pickers, each with its own idea of a search.
 * Menus of actions — an account menu, a row's "…" — are still menus.
 *
 * The ARIA pattern is the combobox with a listbox popup. The search field
 * keeps focus and points at the highlighted option with
 * `aria-activedescendant`. `aria-selected` marks the chosen value, as React
 * Aria does; the highlight is drawn from `data-active`.
 *
 * Built on Radix's Popover, which brings the positioning, dismissal on Escape
 * and outside clicks, and focus returning to the trigger. Modal, because a
 * dialog locks scrolling to its own content and the popover is portalled
 * outside it: a non-modal popover in a peek would not scroll under the wheel.
 *
 * Actions — "View all workspaces", "Open board page" — sit under the options,
 * are never filtered out, and are walked by the same arrow keys.
 */

import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  /** What the option is called: shown, searched, and its accessible name. */
  label: string;
  /** Other words that find it: a slug, a code, a full sha. */
  keywords?: readonly string[] | undefined;
  /** Before the label, in the list and in the trigger. */
  icon?: ReactNode;
  /** After the label in the list, muted: what tells two options apart. */
  detail?: string | undefined;
}

export interface ComboboxAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /**
   * Where it goes, when it goes somewhere: rendered as a link, so a
   * modified click still opens it in a new tab. A plain click and Enter
   * call `onSelect` instead.
   */
  href?: string | undefined;
  onSelect: () => void;
}

/** Case and accents set aside, so "colon" finds "Colón". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The options every word of the query appears in, across the label and the
 * keywords together, in their original order.
 */
export function filterOptions<T extends ComboboxOption>(
  options: readonly T[],
  query: string,
): T[] {
  const terms = fold(query)
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) return [...options];
  return options.filter((option) => {
    const text = fold([option.label, ...(option.keywords ?? [])].join(" "));
    return terms.every((term) => text.includes(term));
  });
}

/** A click the browser would not open somewhere else. */
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

const triggerClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 data-[state=open]:border-ring data-[state=open]:ring-ring/50 flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-transparent px-3 py-1 text-left text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:ring-[3px] md:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const itemClass =
  "data-[active]:bg-accent data-[active]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export function Combobox({
  label,
  options,
  value,
  onValueChange,
  actions = [],
  id,
  "aria-describedby": describedBy,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  disabled = false,
  className,
  trigger,
  contentClassName,
  align = "start",
  sideOffset = 4,
  collisionPadding,
  defaultOpen = false,
  onOpenChange,
}: {
  /**
   * What is being picked. Names the list and the search field, and the
   * default trigger too unless `id` is given — then the page's own
   * `<label htmlFor>` names it.
   */
  label: string;
  options: readonly ComboboxOption[];
  /** The chosen option's value; one no option has shows the placeholder. */
  value: string;
  /** Called with a different value only: picking the chosen one closes. */
  onValueChange: (value: string) => void;
  actions?: readonly ComboboxAction[];
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  /** Classes for the default trigger. */
  className?: string;
  /**
   * A trigger of the caller's own, for a picker that does not sit in a form:
   * a heading, a rail, a line of text. It is given the open state, the
   * keystrokes and the ref, and keeps its own role and name.
   */
  trigger?: ReactElement;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
  /** Open as it mounts: a picker put up only to be picked from. */
  defaultOpen?: boolean;
  /** Told as the list opens and closes, by a pick or by being dismissed. */
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const shown = filterOptions(options, query);
  const count = shown.length + actions.length;
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);
  const itemId = (index: number) => `${listId}-item-${index}`;
  const selected = options.find((option) => option.value === value);

  /**
   * Opens on the chosen option, so it is in view and Enter keeps it, or on
   * the first match for a keystroke typed on the trigger.
   */
  const show = (seed = "") => {
    setQuery(seed);
    setActive(
      seed === ""
        ? Math.max(
            options.findIndex((option) => option.value === value),
            0,
          )
        : 0,
    );
    setOpen(true);
  };

  const choose = (index: number) => {
    setOpen(false);
    const option = shown[index];
    if (option !== undefined) {
      if (option.value !== value) onValueChange(option.value);
      return;
    }
    actions[index - shown.length]?.onSelect();
  };

  const scrollToActive = () => {
    if (activeIndex >= 0) {
      document
        .getElementById(itemId(activeIndex))
        ?.scrollIntoView({ block: "nearest" });
    }
  };
  // Opened by the effect rather than by the initial state, so it opens as a
  // click would: on the chosen option, and with the search focused.
  useEffect(() => {
    if (defaultOpen) show();
  }, []);

  // On open the portal mounts a commit later, so the open itself scrolls in
  // `onOpenAutoFocus`; this keeps the highlight in view as it moves.
  useEffect(() => {
    if (open) scrollToActive();
  }, [open, activeIndex]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (open || disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      show(event.key);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + count) % count);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      // Never the form's submit: Enter here picks.
      event.preventDefault();
      if (activeIndex >= 0) choose(activeIndex);
    } else if (event.key === "Tab") {
      // A list is left the way a native select's is: closed, on the trigger.
      event.preventDefault();
      setOpen(false);
    }
  };

  const itemProps = (index: number) => ({
    id: itemId(index),
    role: "option",
    "data-active": index === activeIndex ? "" : undefined,
    className: itemClass,
    // Before the search field's blur, which would take focus off the list.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onMouseMove: () => {
      if (index !== activeIndex) setActive(index);
    },
  });

  return (
    <Popover.Root
      modal
      open={open}
      onOpenChange={(next) => (next ? show() : setOpen(false))}
    >
      <Popover.Trigger asChild disabled={disabled} onKeyDown={onTriggerKeyDown}>
        {trigger ?? (
          <button
            type="button"
            role="combobox"
            id={id}
            aria-label={id === undefined ? label : undefined}
            aria-describedby={describedBy}
            className={cn(triggerClass, className)}
          >
            {selected?.icon !== undefined && (
              <span className="flex shrink-0 items-center">
                {selected.icon}
              </span>
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                selected === undefined && "text-muted-foreground",
              )}
            >
              {selected?.label ?? placeholder}
            </span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground" />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={label}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(
            "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-64 max-w-(--radix-popover-content-available-width) min-w-(--radix-popover-trigger-width) origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-md border shadow-md outline-none",
            contentClassName,
          )}
          onOpenAutoFocus={(event) => {
            // The search field, not the first focusable thing Radix finds.
            event.preventDefault();
            const search = searchRef.current;
            search?.focus();
            search?.setSelectionRange(search.value.length, search.value.length);
            scrollToActive();
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-3">
            <Search
              aria-hidden="true"
              className="text-muted-foreground size-4 shrink-0"
            />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 ? itemId(activeIndex) : undefined
              }
              autoComplete="off"
              spellCheck={false}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKeyDown}
              className="placeholder:text-muted-foreground h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {shown.length === 0 && (
              <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                {emptyMessage}
              </p>
            )}
            {shown.map((option, index) => {
              const chosen = option.value === value;
              return (
                <div
                  key={option.value}
                  {...itemProps(index)}
                  aria-selected={chosen}
                  onClick={() => choose(index)}
                >
                  {option.icon !== undefined && (
                    <span className="flex shrink-0 items-center">
                      {option.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                  {option.detail !== undefined && (
                    <span className="text-muted-foreground max-w-[50%] shrink-0 truncate text-xs">
                      {option.detail}
                    </span>
                  )}
                  <Check
                    aria-hidden="true"
                    className={cn("text-foreground", !chosen && "invisible")}
                  />
                </div>
              );
            })}
            {actions.length > 0 && (
              <>
                <div aria-hidden="true" className="bg-border -mx-1 my-1 h-px" />
                {actions.map((action, offset) => {
                  const index = shown.length + offset;
                  const content = (
                    <>
                      {action.icon}
                      <span className="min-w-0 flex-1 truncate">
                        {action.label}
                      </span>
                    </>
                  );
                  return action.href === undefined ? (
                    <div
                      key={action.key}
                      {...itemProps(index)}
                      onClick={() => choose(index)}
                    >
                      {content}
                    </div>
                  ) : (
                    <a
                      key={action.key}
                      {...itemProps(index)}
                      href={action.href}
                      tabIndex={-1}
                      onClick={(event) => {
                        if (!isPlainClick(event)) return;
                        event.preventDefault();
                        choose(index);
                      }}
                    >
                      {content}
                    </a>
                  );
                })}
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
