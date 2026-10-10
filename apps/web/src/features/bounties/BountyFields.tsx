/**
 * A bounty's fields, changed where they are shown rather than in a form: its
 * title where it is the heading, its description where it is read, and its
 * tech stack where its context names it. Each saves on its own, sending
 * that field alone. A bounty names no repository: its work may touch any
 * the workspace has connected, whose detected stacks it inherits.
 *
 * Each reads as what it holds until it is asked to change: hovering it, or
 * focusing it from the keyboard, brings up a pencil on its right, and the
 * pencil is the way into its control. Leaving the control puts the field
 * back as it reads, as `EditableField` does for a name.
 *
 * A bounty following its Jira issue takes its text from Jira, so its title
 * and description are shown and not offered; its stack is the workspace's
 * to set either way.
 */

import { workRepositories, type BountyDto } from "@sandbox-factory/shared";
import { BOUNTY_LIMITS, normalizeStack, sameStackName } from "sandbox-factory";
import { Loader2, Pencil } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { StackChips, StackPicker } from "@/components/StackPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { BountyText } from "../../BountyText";
import type { BountyDraft } from "../../useBounties";
import type { GithubRepos } from "../../useGithub";

/** Why a save did not land. `conflict` is a save that lost to another. */
export interface SaveFailure {
  message: string;
  conflict: boolean;
}

/** Saves one change to the bounty: null when it landed. */
export type SaveField = (
  change: Partial<BountyDraft>,
) => Promise<SaveFailure | null>;

/** What a bounty's work inherits of its repositories' stacks. */
export interface WorkspaceStack {
  /** Each technology detected in any of them, once. */
  readonly inherited: string[];
  /** What the inherited names were detected in, for a reader. */
  readonly inheritedFrom: string;
  /** Whether a repository's stack is still being read. */
  readonly reading: boolean;
}

/**
 * The stack a bounty's work inherits: what was detected in the repositories
 * its sizing said it touches, or, before it says or when none of them is
 * still connected, in each of the workspace's, any of which it may touch.
 * What generating its sandbox follows too.
 */
export function workspaceStack(
  repos: GithubRepos,
  touched: readonly { readonly repoId: string }[] = [],
): WorkspaceStack {
  const sources = workRepositories(repos.repos, touched);
  const narrowed = sources.some(({ id }) =>
    touched.some(({ repoId }) => repoId === id),
  );
  const [only] = sources;
  return {
    inherited: normalizeStack(sources.flatMap((repo) => repo.stack ?? [])),
    inheritedFrom:
      sources.length === 1 && only !== undefined
        ? only.fullName
        : narrowed
          ? "the repositories its work touches"
          : "the workspace's repositories",
    reading: sources.some((repo) => repo.stack === null),
  };
}

/** What a field says under itself after a save that did not land. */
function FieldError({ children }: { children: string | null }) {
  return children === null ? null : (
    <p role="alert" className="text-destructive text-xs">
      {children}
    </p>
  );
}

/**
 * Whether a field is being edited, and its pencil, which takes focus back
 * when the field is left from its own controls: the control focus was in
 * goes as the field reads again, and focus would go with it.
 */
function useEditMode() {
  const [editing, setEditing] = useState(false);
  const pencil = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      pencil.current?.focus();
    }
  }, [editing]);
  return {
    editing,
    pencil,
    edit: () => setEditing(true),
    /**
     * Back to reading. `returnFocus` is false for a field left by focusing
     * something else, which keeps that focus; a later close does not take
     * back an earlier one's.
     */
    close: (returnFocus = true) => {
      if (returnFocus) refocus.current = true;
      setEditing(false);
    },
  };
}

/**
 * The pencil on a field's right, its way in: shown while the field is
 * hovered (`group/field`) or the pencil has focus, so the keyboard still
 * finds it, and always on a touch screen, which has no hover. Held in the
 * layout either way, so nothing moves as it appears.
 */
function EditButton({
  label,
  ref,
  disabled = false,
  className,
  onClick,
}: {
  label: string;
  ref: Ref<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 coarse:opacity-100 grid size-7 shrink-0 place-items-center rounded-md opacity-0 transition-opacity outline-none group-hover/field:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] disabled:pointer-events-none",
        className,
      )}
      onClick={onClick}
    >
      <Pencil className="size-3.5" />
    </button>
  );
}

/**
 * A field's box: padded out into its margin, so the card it is shown on
 * leaves its text where it was.
 */
const fieldBox = "-m-2 rounded-lg p-2 transition-colors";

/**
 * The card behind a field that reads, while it is hovered or its pencil
 * has keyboard focus: what the pencil will change. Not while it is edited,
 * when its control is the field, nor when it cannot be.
 */
const readCard = "hover:bg-muted/60 has-focus-visible:bg-muted/60";

/**
 * The bounty's title as its heading, renamed in place: its pencil opens it
 * as a field, Enter or leaving it saves, and Escape puts it back.
 */
export function InlineTitle({
  as: Heading,
  value,
  locked,
  size,
  onSave,
}: {
  as: "h1" | "h2";
  value: string;
  /** Follows Jira: shown, not offered. */
  locked: boolean;
  size: "page" | "panel";
  onSave: SaveField;
}) {
  const mode = useEditMode();
  // What is typed; null while it is the title as saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A save on Enter is followed by the field's blur; one save is enough.
  const pending = useRef(false);
  const text =
    size === "page"
      ? "text-title md:text-title"
      : "text-xl font-semibold tracking-tight md:text-xl";

  const close = (returnFocus = true) => {
    mode.close(returnFocus);
    setDraft(null);
    setError(null);
  };
  /** Saves what is typed; `blurred` when it was left by focusing elsewhere. */
  const commit = async (blurred = false) => {
    if (pending.current) return;
    const next = (draft ?? value).trim();
    if (next === "") {
      setError("A bounty needs a title.");
      return;
    }
    if (next === value) {
      close(!blurred);
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    const failure = await onSave({ title: next });
    pending.current = false;
    setSaving(false);
    if (failure === null) {
      close(!blurred);
      return;
    }
    setError(failure.message);
    // It shows theirs now, so saving again cannot undo it.
    if (failure.conflict) setDraft(null);
  };

  if (locked) {
    return <Heading className={cn(text, "break-words")}>{value}</Heading>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {mode.editing ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Title"
            data-own-escape
            autoFocus
            className={cn(text, "h-auto px-1.5 py-0.5")}
            value={draft ?? value}
            maxLength={BOUNTY_LIMITS.title}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
            onBlur={() => void commit(true)}
          />
          {saving && (
            <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
          )}
        </div>
      ) : (
        <div
          className={cn(
            "group/field flex min-w-0 items-start justify-between gap-2",
            fieldBox,
            readCard,
          )}
        >
          <Heading className={cn(text, "min-w-0 break-words")}>{value}</Heading>
          <EditButton
            ref={mode.pencil}
            label="Rename"
            // Level with the heading's first line.
            className={size === "page" ? "mt-0.5" : undefined}
            onClick={mode.edit}
          />
        </div>
      )}
      <FieldError>{error}</FieldError>
    </div>
  );
}

/**
 * The bounty's description, read as Markdown and written in place: its
 * pencil opens it as a text area, saved with Save or ⌘↵ and put back with
 * Cancel or Escape.
 *
 * Not `labelled` where something else heads it, as a page's tab does: its
 * heading is then a field's label over the text, and its pencil sits in the
 * text's corner.
 */
export function InlineDescription({
  bounty,
  locked,
  labelled = true,
  label = "Description",
  onSave,
}: {
  bounty: BountyDto;
  locked: boolean;
  labelled?: boolean;
  /** What the field is called, as its heading or its label. */
  label?: string;
  onSave: SaveField;
}) {
  const headingId = useId();
  const mode = useEditMode();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = bounty.description;

  const close = () => {
    mode.close();
    setDraft(null);
    setError(null);
  };
  const commit = async () => {
    const next = draft ?? value;
    if (next === value) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    const failure = await onSave({ description: next });
    setSaving(false);
    if (failure === null) {
      close();
      return;
    }
    setError(failure.message);
    if (failure.conflict) setDraft(null);
  };

  const text = (
    <BountyText description={value} inputTruncated={bounty.inputTruncated} />
  );
  const pencil = !locked && !mode.editing && (
    <EditButton
      ref={mode.pencil}
      label="Edit description"
      className={labelled ? undefined : "absolute top-3 right-3"}
      onClick={mode.edit}
    />
  );

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "group/field relative flex min-w-0 flex-col gap-2",
        fieldBox,
        !locked && !mode.editing && readCard,
      )}
    >
      {labelled ? (
        <div className="flex min-h-8 items-center justify-between gap-3">
          <h3 id={headingId} className="eyebrow">
            {label}
          </h3>
          {pencil}
        </div>
      ) : (
        <h3 id={headingId} className="text-sm font-medium">
          {label}
        </h3>
      )}
      {!mode.editing ? (
        labelled ? (
          text
        ) : (
          // Its pencil in the corner of the card the text is read on.
          <div className="relative">
            {text}
            {pencil}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-labelledby={headingId}
            aria-describedby={`${headingId}-hint`}
            data-own-escape
            autoFocus
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-48 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50 md:text-sm"
            value={draft ?? value}
            maxLength={BOUNTY_LIMITS.description}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              id={`${headingId}-hint`}
              className="text-muted-foreground text-xs"
            >
              What should be true when it is done. Markdown works.
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void commit()}
              >
                {saving && <Loader2 className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
      <FieldError>{error}</FieldError>
    </section>
  );
}

/**
 * What the work is done in: the stack detected in its repositories, which
 * stays, and what the bounty adds. Read as its chips; its pencil opens the picker,
 * where each addition and removal saves at once, and Done or Escape puts it
 * back as it reads.
 */
export function StackField({
  bounty,
  repos,
  readOnly = false,
  onSave,
}: {
  bounty: BountyDto;
  repos: GithubRepos;
  /** Read, with no pencil, as in a panel. */
  readOnly?: boolean;
  onSave: SaveField;
}) {
  const id = useId();
  const mode = useEditMode();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { inherited, inheritedFrom } = workspaceStack(
    repos,
    bounty.proposal?.repositories,
  );
  const added = bounty.stack.filter(
    (name) => !inherited.some((own) => sameStackName(own, name)),
  );
  return (
    <InlineField
      id={id}
      label="Tech stack"
      mode={mode}
      readOnly={readOnly}
      saving={saving}
      error={error}
    >
      {mode.editing ? (
        /*
          Its own Escape: the picker's closes its list, and one with the
          list closed is the field's, not the panel's around it.
        */
        <div
          data-own-escape
          className="flex flex-col gap-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            mode.close();
          }}
        >
          <StackPicker
            id={id}
            inherited={inherited}
            inheritedFrom={inheritedFrom}
            value={added}
            disabled={saving}
            autoFocus
            onChange={(next) => {
              setSaving(true);
              setError(null);
              // Only what the bounty adds: the repositories' own follow them.
              void onSave({ stack: next }).then((failure) => {
                setSaving(false);
                setError(failure?.message ?? null);
              });
            }}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => mode.close()}
            >
              Done
            </Button>
          </div>
        </div>
      ) : inherited.length === 0 && added.length === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <StackChips
          inherited={inherited}
          inheritedFrom={inheritedFrom}
          own={added}
        />
      )}
    </InlineField>
  );
}

/**
 * A field in the bounty's context: its label, with the pencil on its right
 * while it reads, the value or its control, and its error.
 */
function InlineField({
  id,
  label,
  mode,
  readOnly,
  saving,
  error,
  children,
}: {
  id: string;
  label: string;
  mode: ReturnType<typeof useEditMode>;
  readOnly: boolean;
  saving: boolean;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/field flex flex-col gap-1.5 text-sm",
        fieldBox,
        !readOnly && !mode.editing && readCard,
      )}
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
        {/* Names the control while there is one; the value is read under it. */}
        <label
          htmlFor={mode.editing ? id : undefined}
          className="flex items-center gap-1.5 font-medium"
        >
          {label}
          {saving && (
            <Loader2 className="text-muted-foreground size-3 animate-spin" />
          )}
        </label>
        {!readOnly && !mode.editing && (
          <EditButton
            ref={mode.pencil}
            label={`Edit ${label.toLowerCase()}`}
            disabled={saving}
            onClick={mode.edit}
          />
        )}
      </div>
      {children}
      <FieldError>{error}</FieldError>
    </div>
  );
}
