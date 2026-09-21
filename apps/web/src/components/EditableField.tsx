/**
 * A value that reads as text until you decide to change it.
 *
 * The three names a person or an organization is known by — a display name,
 * a username, an organization handle — are read far more often than they are
 * edited, so their resting state is prose. An input beside a Save button on
 * every visit presents a decision nobody came to make, and makes a settled
 * value look unsaved.
 *
 * Hovering or focusing reveals a pencil; committing or cancelling returns it
 * to text. The editing state is the exception, which is why it is the one
 * that has to be asked for.
 *
 * The outcome is reported here rather than by the page, because a line at the
 * foot of a card cannot say which of three fields it refers to — and a
 * refusal has to arrive where the rejected text still is, or there is nothing
 * to correct.
 */

import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function EditableField({
  label,
  value,
  placeholder,
  prefix,
  busy = false,
  canEdit = true,
  readOnlyReason,
  validate,
  onSave,
  onDirty,
  className,
}: {
  /** Names the value, above it, and labels the input while editing. */
  label: string;
  /** What is stored now. The draft re-seeds from it whenever it changes. */
  value: string;
  placeholder?: string;
  /**
   * Shown before the value at rest — `@` for a handle. Not part of the value,
   * so it never reaches the draft or the server.
   */
  prefix?: string;
  /** A save is in flight somewhere on the page. */
  busy?: boolean;
  /** False when the viewer may read this but not change it. */
  canEdit?: boolean;
  /** Why editing is unavailable, when it is. */
  readOnlyReason?: string | undefined;
  /**
   * Whether a draft may be submitted. Defaults to "not blank"; the handle
   * fields pass the shared rules from `packages/core`.
   */
  validate?: (draft: string) => boolean;
  /**
   * Saves, and says what happened. Returning a string reports a refusal — the
   * field stays open holding the rejected text, so it can be fixed rather
   * than retyped. Returning nothing means it worked.
   */
  onSave: (next: string) => Promise<string | void> | string | void;
  /** Called as the draft changes, so a page can clear a stale message. */
  onDirty?: () => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  /** Set briefly after a save, for the tick beside the value. */
  const [justSaved, setJustSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * Re-seed from the stored value. This runs on the way into editing and
   * whenever a save lands, so a cancelled edit leaves nothing behind and a
   * rename refused by the server does not strand the rejected text.
   */
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Focus on entry, so the field can be typed into without a second click.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const valid = validate === undefined ? draft.trim() !== "" : validate(draft);

  /*
   * Clear the tick a moment after it appears. It confirms something the
   * reader just did and then gets out of the way; a permanent "Saved." next
   * to a value says nothing a minute later, and starts reading as part of it.
   */
  useEffect(() => {
    if (!justSaved) {
      return;
    }
    const timer = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  function cancel() {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) {
      return;
    }
    const next = draft.trim();
    setError(null);
    // Nothing changed: closing without a round trip is the honest outcome,
    // and a tick for a save that never happened would be a small lie.
    if (next === value) {
      setEditing(false);
      return;
    }
    const failure = await onSave(next);
    if (typeof failure === "string") {
      // Held open, holding what was typed: the refusal is about this text, so
      // this is the only place it can be acted on.
      setError(failure);
      return;
    }
    setEditing(false);
    setJustSaved(true);
  }

  if (!editing) {
    return (
      <div className={cn("flex flex-col gap-0.5", className)}>
        <FieldLabel>{label}</FieldLabel>
        {/*
          The tick is decorative, so the outcome is announced here instead —
          politely, and only while it is fresh.

          Rendered only when there is something to say. A live region that is
          always present but usually empty is one more `status` on the page
          for anything looking for one, and announces nothing anyway.
        */}
        {justSaved && (
          <span role="status" className="sr-only">
            {label} saved
          </span>
        )}
        {canEdit ? (
          /*
           * One button carrying the value and the pencil, rather than text
           * with a control beside it: the whole line is the target, which is
           * easier to hit and gives the keyboard a single stop.
           */
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Edit ${label.toLowerCase()}`}
            className="group/edit focus-visible:ring-ring/50 -mx-1.5 flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-transparent focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-default"
          >
            <span className="truncate text-sm font-medium">
              {prefix}
              {value === "" ? (
                <span className="text-muted-foreground font-normal">
                  {placeholder ?? "Not set"}
                </span>
              ) : (
                value
              )}
            </span>
            {/*
              Visible on hover and whenever the line has keyboard focus. Held
              in the layout rather than rendered conditionally, so nothing
              shifts sideways as the pointer arrives.
            */}
            {/*
              The pencil gives way to the tick, rather than the two sharing
              the line: both in the same slot means nothing moves as one
              replaces the other.
            */}
            {justSaved ? (
              <Check
                className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500"
                strokeWidth={2.4}
                aria-hidden="true"
              />
            ) : (
              <Pencil
                className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            )}
          </button>
        ) : (
          <>
            <p className="-mx-1.5 truncate px-1.5 py-0.5 text-sm font-medium">
              {prefix}
              {value}
            </p>
            {/*
              Said out loud rather than left in a `title`: a tooltip is only
              found by hovering something that looks inert, so the reason a
              value cannot be edited would never be read by the person it
              applies to.
            */}
            {readOnlyReason !== undefined && (
              <p className="text-muted-foreground text-xs">{readOnlyReason}</p>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={cn("flex flex-col gap-0.5", className)}
    >
      <FieldLabel htmlFor={`field-${label}`}>{label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <Input
          id={`field-${label}`}
          ref={inputRef}
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            // The refusal was about what was there a moment ago; leaving it
            // up while somebody fixes it makes the fix look rejected too.
            setError(null);
            onDirty?.();
          }}
          // Escape leaves without saving, which is what every other text field
          // in a browser does.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          className="h-8"
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          disabled={busy || !valid}
          aria-label={`Save ${label.toLowerCase()}`}
        >
          <Check />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="text-muted-foreground size-8 shrink-0"
          disabled={busy}
          onClick={cancel}
          aria-label={`Cancel editing ${label.toLowerCase()}`}
        >
          <X />
        </Button>
      </div>

      {/*
        Under the input it belongs to, not at the foot of the card: a refusal
        names this value, and the text it refuses is still on screen here.
      */}
      {error !== null && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </form>
  );
}

/** The small caption naming a value, in both states so nothing shifts. */
function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-muted-foreground text-xs font-medium"
    >
      {children}
    </label>
  );
}
