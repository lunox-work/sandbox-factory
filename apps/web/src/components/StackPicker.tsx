/**
 * A tech stack, picked from the catalog or typed.
 *
 * The field searches the catalog, grouped by kind, and offers a name the
 * catalog lacks as itself. What is chosen is listed under it, one row each,
 * led by the technology's logo. A row the repository brought (`inherited`)
 * is locked: it is the repository's, detected from its code, so it ends in a
 * lock where the other ends in its remove button, and offers no way to
 * remove it. A row the person added carries that button, shown while the
 * row is hovered or the button has focus.
 *
 * A combobox in the ARIA pattern, hand-rolled because the app carries no
 * command menu: the input keeps focus, the arrow keys move the active
 * option, Enter takes it and closes the list, Escape closes it too, and
 * Backspace in an empty field removes the last technology the person added.
 */

import { Lock, Plus, X } from "lucide-react";
import {
  STACK_CATALOG,
  STACK_LIMITS,
  canonicalStackName,
  sameStackName,
  stackTechnology,
  type StackKind,
} from "sandbox-factory";
import { useId, useRef, useState } from "react";

import { StackIcon } from "@/components/StackIcon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** How each kind is headed in the list. */
export const STACK_KIND_LABELS: Record<StackKind, string> = {
  language: "Languages",
  framework: "Frameworks",
  database: "Data & messaging",
  service: "Services",
  tool: "Tools",
};

interface Option {
  /** What is added when it is picked. */
  readonly name: string;
  /** Null for a name the catalog lacks, offered as typed. */
  readonly kind: StackKind | null;
}

/** A chip the repository brought: locked, and said to be so. */
function InheritedChip({ name, from }: { name: string; from: string }) {
  return (
    <li
      className="bg-muted text-muted-foreground inline-flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium"
      title={`Detected in ${from}`}
    >
      <StackIcon name={name} className="size-3.5" />
      {name}
      <span className="sr-only">, detected in {from}</span>
      <Lock aria-hidden="true" className="size-3 shrink-0" />
    </li>
  );
}

/**
 * The picker's row for a technology the repository brought: locked, its lock
 * where an added one's remove button is.
 */
function InheritedRow({ name, from }: { name: string; from: string }) {
  return (
    <li
      className="text-muted-foreground flex h-8 items-center gap-2 pr-1.5 pl-3 text-sm"
      title={`Detected in ${from}`}
    >
      <StackIcon name={name} className="size-4" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="sr-only">, detected in {from}</span>
      <span className="grid size-6 shrink-0 place-items-center">
        <Lock aria-hidden="true" className="size-3.5" />
      </span>
    </li>
  );
}

/**
 * A stack shown, not edited: the repository's chips locked, then the
 * bounty's own. Nothing when both are empty.
 */
export function StackChips({
  inherited,
  inheritedFrom,
  own,
}: {
  inherited: readonly string[];
  inheritedFrom: string;
  own: readonly string[];
}) {
  const added = own.filter(
    (name) => !inherited.some((repo) => sameStackName(repo, name)),
  );
  if (inherited.length === 0 && added.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tech stack">
      {inherited.map((name) => (
        <InheritedChip key={`repo:${name}`} name={name} from={inheritedFrom} />
      ))}
      {added.map((name) => (
        <li
          key={name}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium"
        >
          <StackIcon name={name} className="size-3.5" />
          {name}
        </li>
      ))}
    </ul>
  );
}

export function StackPicker({
  id,
  describedBy,
  inherited,
  inheritedFrom,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  /** The text field's id, which the label names. */
  id: string;
  describedBy?: string | undefined;
  /** The repository's detected stack: shown first, and locked. */
  inherited: readonly string[];
  /** Where the locked chips came from, as a person reads it. */
  inheritedFrom: string;
  /** What the person added. Never repeats an inherited name. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Focused as it mounts, and so open: put up to be picked from. */
  autoFocus?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const taken = (name: string) =>
    inherited.some((repo) => sameStackName(repo, name)) ||
    value.some((own) => sameStackName(own, name));
  const full = inherited.length + value.length >= STACK_LIMITS.items;

  // In catalog order, so grouped by kind. A name the catalog does not
  // have is offered as typed, last, so Enter on a part of a name takes
  // the catalog's match rather than the fragment.
  const typed = query.trim().replace(/\s+/g, " ");
  const lower = typed.toLowerCase();
  const options: Option[] = [
    ...STACK_CATALOG.filter(
      ({ name, aliases }) =>
        !taken(name) &&
        (lower === "" ||
          [name, ...(aliases ?? [])].some((spelling) =>
            spelling.toLowerCase().includes(lower),
          )),
    ).map(({ name, kind }): Option => ({ name, kind })),
    ...(typed !== "" && stackTechnology(typed) === undefined && !taken(typed)
      ? [{ name: typed, kind: null }]
      : []),
  ];

  const add = (name: string) => {
    const canonical = canonicalStackName(name);
    if (canonical === "" || taken(canonical) || full) return;
    onChange([...value, canonical]);
    setQuery("");
    setActive(0);
    // Done picking: the list closes, and typing or a click opens it again.
    setOpen(false);
  };
  const remove = (name: string) => {
    onChange(value.filter((own) => own !== name));
  };

  const showList = open && !disabled && !full && options.length > 0;
  const activeIndex = Math.min(active, options.length - 1);
  const optionId = (index: number) => `${listId}-option-${index}`;

  // The options in list order, under their kind's heading. The catalog's
  // order is its kinds', so each heading comes once.
  const groups: { label: string | null; items: [Option, number][] }[] = [];
  options.forEach((option, index) => {
    const label = option.kind === null ? null : STACK_KIND_LABELS[option.kind];
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.items.push([option, index]);
    } else {
      groups.push({ label, items: [[option, index]] });
    }
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList ? optionId(activeIndex) : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder={
            full ? `At most ${STACK_LIMITS.items}` : "Select tech stack"
          }
          value={query}
          maxLength={STACK_LIMITS.name}
          disabled={disabled || full}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Already focused after a pick, so focus alone would not reopen it.
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              if (options.length === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + options.length) % options.length);
            } else if (event.key === "Enter") {
              // Never the form's submit: Enter here picks.
              if (!showList && query.trim() === "") return;
              event.preventDefault();
              const option = options[activeIndex];
              if (showList && option !== undefined) add(option.name);
            } else if (event.key === "Escape" && showList) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "Backspace" && query === "") {
              const last = value[value.length - 1];
              if (last !== undefined) remove(last);
            }
          }}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Technologies"
          hidden={!showList}
          className="bg-popover text-popover-foreground absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border p-1 shadow-md"
        >
          {showList &&
            groups.map((group) => (
              <div
                key={group.label ?? "typed"}
                role="group"
                aria-label={group.label ?? "Your own"}
              >
                {group.label !== null && (
                  <div
                    aria-hidden="true"
                    className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium"
                  >
                    {group.label}
                  </div>
                )}
                {group.items.map(([option, index]) => (
                  <div
                    key={`${option.kind ?? "typed"}:${option.name}`}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                      index === activeIndex &&
                        "bg-accent text-accent-foreground",
                    )}
                    // Before the input's blur, which would close the list.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => add(option.name)}
                  >
                    {option.kind === null ? (
                      <>
                        <Plus
                          aria-hidden="true"
                          className="text-muted-foreground size-4 shrink-0"
                        />
                        <span>
                          Add{" "}
                          <span className="font-medium">“{option.name}”</span>
                        </span>
                      </>
                    ) : (
                      <>
                        <StackIcon name={option.name} className="size-4" />
                        {option.name}
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
      {(inherited.length > 0 || value.length > 0) && (
        <ul
          className={cn(
            "flex flex-col",
            disabled && "cursor-not-allowed opacity-50",
          )}
          aria-label="Chosen technologies"
        >
          {inherited.map((name) => (
            <InheritedRow
              key={`repo:${name}`}
              name={name}
              from={inheritedFrom}
            />
          ))}
          {value.map((name) => (
            <li
              key={name}
              className="group flex h-8 items-center gap-2 pr-1.5 pl-3 text-sm"
            >
              <StackIcon name={name} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {/*
                Shown while the row is hovered, and while it has focus, so
                the keyboard still finds it. Always on a touch screen, which
                has no hover.
              */}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground hover:bg-accent pointer-coarse:opacity-100 grid size-6 shrink-0 place-items-center rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Remove ${name}`}
                disabled={disabled}
                onClick={() => {
                  remove(name);
                  // Back to the field, since the button goes with its row,
                  // but with the list left closed: focusing the field opens
                  // it, and removing is not picking.
                  inputRef.current?.focus();
                  setOpen(false);
                }}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
