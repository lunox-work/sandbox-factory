/**
 * A bounty's fields, changed where they are shown rather than in a form: its
 * title where it is the heading, its description where it is read, and its
 * repository and tech stack where its context names them. Each saves on its
 * own, sending that field alone.
 *
 * Each reads as what it holds until it is asked to change: hovering it, or
 * focusing it from the keyboard, brings up a pencil on its right, and the
 * pencil is the way into its control. Leaving the control puts the field
 * back as it reads, as `EditableField` does for a name.
 *
 * A bounty following its Jira issue takes its text from Jira, so its title
 * and description are shown and not offered; its repository and stack are
 * the workspace's to set either way.
 */

import type { BountyDto, GithubRepoDto } from "@sandbox-factory/shared";
import { BOUNTY_LIMITS, sameStackName } from "sandbox-factory";
import { Loader2, Pencil } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { StackChips, StackPicker } from "@/components/StackPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { BountyText } from "../../BountyText";
import { ProviderIcon } from "../../ProviderIcon";
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

/**
 * The repositories a bounty can be about: the workspace's sources still on
 * GitHub, and the one it names whatever its state. A repository the list has
 * not shown yet is offered as itself, or the picker would show "None" while
 * the bounty still names it.
 */
export function repositoryOptions(
  repos: GithubRepos,
  repoId: string,
  none = "None",
): ComboboxOption[] {
  const choices: GithubRepoDto[] = repos.repos.filter(
    (repo) =>
      (repo.role === "source" && repo.syncStatus !== "gone") ||
      repo.id === repoId,
  );
  const other =
    repoId !== "" && !choices.some(({ id }) => id === repoId) ? repoId : null;
  return [
    { value: "", label: none },
    ...choices.map((repo) => ({
      value: repo.id,
      label: repo.fullName,
      icon: <ProviderIcon provider="github" />,
    })),
    ...(other === null
      ? []
      : [
          {
            value: other,
            label: repos.loading ? "…" : "Unavailable",
            icon: <ProviderIcon provider="github" />,
          },
        ]),
  ];
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
      ? "text-2xl font-semibold tracking-tight md:text-2xl"
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
          <h3
            id={headingId}
            className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
          >
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
 * The repository a bounty is about: named, with its pencil opening the
 * picker on its list. A pick saves; the list closing, picked from or not,
 * puts it back as it reads. A bounty from Jira with none uses its board's.
 */
export function RepositoryField({
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
  const value = bounty.repoId ?? "";
  const none = bounty.jira === null ? "None" : "Its board's, if it has one";
  const options = repositoryOptions(repos, value, none);
  const chosen = options.find((option) => option.value === value);
  return (
    <InlineField
      id={id}
      label="Repository"
      mode={mode}
      readOnly={readOnly}
      saving={saving}
      error={error}
    >
      {mode.editing ? (
        <Combobox
          id={id}
          label="Repository"
          searchPlaceholder="Search repositories…"
          emptyMessage={
            repos.loading ? "Loading repositories…" : "No repository matches."
          }
          options={options}
          value={value}
          disabled={saving}
          defaultOpen
          onOpenChange={(open) => {
            if (!open) mode.close();
          }}
          onValueChange={(next) => {
            setSaving(true);
            setError(null);
            void onSave({ repoId: next === "" ? null : next }).then(
              (failure) => {
                setSaving(false);
                setError(failure?.message ?? null);
              },
            );
          }}
        />
      ) : value === "" || chosen === undefined ? (
        <p className="text-muted-foreground flex min-h-9 items-center">
          {none}
        </p>
      ) : (
        // As tall as the picker's trigger, so nothing under it moves.
        <p className="flex min-h-9 min-w-0 items-center gap-2">
          <span className="flex size-4 shrink-0 items-center">
            {chosen.icon}
          </span>
          <span className="min-w-0 truncate">{chosen.label}</span>
        </p>
      )}
    </InlineField>
  );
}

/**
 * What the work is done in: the repository's detected stack, which stays,
 * and what the bounty adds. Read as its chips; its pencil opens the picker,
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
  const repo = repos.repos.find(({ id }) => id === bounty.repoId);
  const inherited = repo?.stack ?? [];
  const inheritedFrom = repo?.fullName ?? "the repository";
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
              // Only what the bounty adds: the repository's own follow it.
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
