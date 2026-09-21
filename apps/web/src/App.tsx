import type { TodoDto } from "@sandbox-factory/shared";
import { Check, Plus, Trash2 } from "lucide-react";
import {
  TODO_FILTERS,
  filterTodos,
  isValidTitle,
  type TodoFilter,
} from "sandbox-factory";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { Account } from "./Account";
import { signOut, useSession } from "./auth";
import { CreateOrganization, Organization } from "./Organization";
import { Organizations } from "./Organizations";
import { Jira } from "./Jira";
import { SideNav, type Screen } from "./SideNav";
import { SignIn } from "./SignIn";
import { useOrganizations } from "./useOrganizations";
import { useTodos } from "./useTodos";

export function App() {
  const { data: session, isPending } = useSession();

  // Three states, not two: rendering sign-in while the session resolves would
  // flash it at a signed-in user on every reload.
  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }

  if (session === null) {
    return <SignIn />;
  }

  /**
   * Keyed by user id, so switching account remounts everything below. Without
   * the key, `useTodos` keeps the previous user's rows on screen until a
   * refetch replaces them, which reads as one account showing another's data.
   */
  return (
    <Signed
      key={session.user.id}
      name={session.user.name}
      email={session.user.email}
      image={session.user.image}
    />
  );
}

function Signed({
  name,
  email,
  image,
}: {
  name: string;
  email?: string | undefined;
  image?: string | null;
}) {
  // A value rather than a router: a handful of screens, each with a path.
  // Read from the path so a reload, a bookmark, or the return from a provider
  // link all land on the screen the URL names.
  const [screen, setScreen] = useState<Screen>(() =>
    screenForPath(window.location.pathname),
  );

  /**
   * The organization the app is showing. The handle in the URL wins over the
   * remembered choice, so `/o/acme/settings` opens Acme even when another was
   * active last.
   */
  const organizations = useOrganizations(slugForPath(window.location.pathname));

  /*
   * The Back button. `pushState` below adds an entry per navigation, so the
   * browser offers to go back — and this is what makes it do something:
   * without it the URL would change while the screen stayed put.
   */
  useEffect(() => {
    function onPopState() {
      setScreen(screenForPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * `slug` names the organization a path should carry, for the rows on the
   * organizations page: `select` has not re-rendered yet when this runs, so
   * reading the active one here would write the *previous* organization's
   * handle into the URL.
   */
  function navigate(next: Screen, slug?: string) {
    if (next === screen && slug === undefined) {
      return;
    }
    // `pushState`, so each navigation is its own history entry and Back
    // returns to the previous screen rather than leaving the app.
    window.history.pushState(
      null,
      "",
      pathForScreen(next, slug ?? organizations.active?.slug),
    );
    setScreen(next);
  }

  return (
    /*
      A flex row, as in the reference: the rail is a static sibling of the
      content rather than laid over it, and the content scrolls in its own box
      so the rail cannot scroll away.

      On a phone the rail is a fixed bottom bar instead, so the row collapses
      and the padding keeps the last row clear of it.
    */
    <div className="flex min-h-dvh flex-col sm:h-dvh sm:flex-row sm:overflow-hidden">
      <SideNav
        screen={screen}
        name={name}
        email={email}
        image={image}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
      <div className="min-w-0 flex-1 pb-16 sm:overflow-y-auto sm:pb-0">
        {screen === "account" ? (
          <Account onJoined={() => void organizations.refresh()} />
        ) : screen === "organizations" ? (
          <Organizations
            organizations={organizations.organizations}
            loading={organizations.loading}
            error={organizations.error}
            onOpen={(organization) => {
              // Selecting here is what makes `org-settings` show this one:
              // the settings screen reads the active organization.
              organizations.select(organization.id);
              navigate("org-settings", organization.slug);
            }}
            onCreate={() => navigate("create-org")}
          />
        ) : screen === "create-org" ? (
          <CreateOrganization
            onCreated={(id) => {
              void organizations.refresh();
              organizations.select(id);
              navigate("todos");
            }}
            onCancel={() => navigate("todos")}
          />
        ) : screen === "org-jira" ? (
          organizations.active === null ? (
            <main className="mx-auto w-full max-w-2xl px-4 py-10">
              <p className="text-muted-foreground text-sm">
                {organizations.loading
                  ? "Loading…"
                  : "You are not in an organization yet."}
              </p>
            </main>
          ) : (
            <Jira
              // Keyed by id for the same reason as the settings page: the
              // connection list belongs to one organization.
              key={organizations.active.id}
              organizationId={organizations.active.id}
              organizationName={organizations.active.name}
              role={organizations.active.role}
            />
          )
        ) : screen === "org-settings" ? (
          organizations.active === null ? (
            // Either the list has not arrived or the person is in none. Both
            // read the same from here, and both are transient.
            <main className="mx-auto w-full max-w-2xl px-4 py-10">
              <p className="text-muted-foreground text-sm">
                {organizations.loading
                  ? "Loading…"
                  : "You are not in an organization yet."}
              </p>
            </main>
          ) : (
            <Organization
              // Keyed by id so switching organization remounts the forms
              // rather than leaving the previous one's handle in the field.
              key={organizations.active.id}
              organization={organizations.active}
              onChanged={() => void organizations.refresh()}
              onOpenJira={() => {
                navigate("org-jira", organizations.active?.slug);
              }}
              onLeft={() => {
                void organizations.refresh();
                navigate("todos");
              }}
            />
          )
        ) : (
          <Todos />
        )}
      </div>
    </div>
  );
}

/**
 * The path each screen lives at, and the screen each path names.
 *
 * One pair of functions rather than a router: with two screens a table would
 * be more machinery than mapping. Anything unrecognised is the todo list, so a
 * stale bookmark or a typo lands somewhere useful instead of on a blank page —
 * which is also what nginx's `try_files` and the dev server's history
 * fallback already assume by serving `index.html` for any path.
 */
const ACCOUNT_PATH = "/account";
const ORGANIZATIONS_PATH = "/organizations";
const NEW_ORG_PATH = "/organizations/new";

/**
 * The organization handle a path names, for `/o/{slug}/...`. Undefined
 * elsewhere, which leaves the remembered choice in charge.
 */
function slugForPath(pathname: string): string | undefined {
  // Not a regex: `[1]` on a split is enough, and a handle is already
  // constrained by the core rules.
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]
    : undefined;
}

function screenForPath(pathname: string): Screen {
  // Trailing slashes are equivalent: `/account/` is the same screen.
  const path = pathname.replace(/\/+$/, "");
  if (path === ACCOUNT_PATH) {
    return "account";
  }
  if (path === NEW_ORG_PATH) {
    return "create-org";
  }
  if (path === ORGANIZATIONS_PATH) {
    return "organizations";
  }
  if (slugForPath(pathname) !== undefined) {
    // `/o/:slug/jira` and `/o/:slug/settings` differ only in the last segment.
    return path.endsWith("/jira") ? "org-jira" : "org-settings";
  }
  return "todos";
}

function pathForScreen(screen: Screen, slug?: string | undefined): string {
  switch (screen) {
    case "account":
      return ACCOUNT_PATH;
    case "organizations":
      return ORGANIZATIONS_PATH;
    case "create-org":
      return NEW_ORG_PATH;
    case "org-settings":
      // Without an organization there is nothing to name, so fall back to the
      // list rather than inventing a handle.
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/settings`;
    case "org-jira":
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/jira`;
    case "todos":
      return "/";
  }
}

function Todos() {
  const { todos, error, loading, create, setDone, rename, remove } = useTodos();
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");

  // From packages/core, shared with the extension, so the two surfaces cannot
  // disagree about what "active" means.
  const visible = filterTodos(todos, filter);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTitle(title)) {
      return;
    }
    void create(title);
    setTitle("");
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {/*
        Just the title. The counts, the signed-in name and sign out all used to
        crowd this line; none of them is part of writing a todo, and the first
        two are answered by the list itself and by the avatar in the rail.
      */}
      <h1 className="text-2xl font-semibold tracking-tight">Todos</h1>

      <form onSubmit={onSubmit} className="mt-6 flex gap-2">
        <Input
          aria-label="Todo title"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" disabled={!isValidTitle(title)}>
          <Plus />
          Add
        </Button>
      </form>

      <nav className="mt-6 flex gap-1" aria-label="Filter todos">
        {TODO_FILTERS.map((option) => (
          <Button
            key={option}
            type="button"
            variant={option === filter ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={option === filter}
            onClick={() => setFilter(option)}
            className="capitalize"
          >
            {option}
          </Button>
        ))}
      </nav>

      {error !== null && (
        <p
          role="alert"
          className="text-destructive border-destructive/35 bg-destructive/7 mt-6 rounded-lg border px-3 py-2.5 text-sm"
        >
          {error}
        </p>
      )}

      {visible.length === 0 && !loading ? (
        <p className="text-muted-foreground mt-10 text-center text-sm">
          {todos.length === 0
            ? "Nothing here yet. Add something above."
            : `No ${filter} todos.`}
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {visible.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onToggle={setDone}
              onRename={rename}
              onRemove={remove}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function TodoRow({
  todo,
  onToggle,
  onRename,
  onRemove,
}: {
  todo: TodoDto;
  onToggle: (id: string, done: boolean) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);

  function commit() {
    setEditing(false);
    // An unchanged or unusable draft is a cancel, not an error.
    if (draft !== todo.title && isValidTitle(draft)) {
      onRename(todo.id, draft);
    } else {
      setDraft(todo.title);
    }
  }

  return (
    <li
      className={cn(
        "group bg-card flex items-center gap-3 rounded-xl border px-3 py-2.5 shadow-xs transition-colors",
        "hover:border-foreground/15",
      )}
    >
      {/*
        A real checkbox, restyled: `appearance-none` drops the native control
        but keeps the semantics and the keyboard behaviour that a div with a
        click handler would have to reimplement.
      */}
      <label className="relative grid shrink-0 place-items-center">
        <input
          type="checkbox"
          checked={todo.done}
          aria-label={`Mark "${todo.title}" as ${todo.done ? "not done" : "done"}`}
          onChange={(event) => onToggle(todo.id, event.target.checked)}
          className={cn(
            "peer border-input size-[1.15rem] cursor-pointer appearance-none rounded-[0.35rem] border transition-colors",
            "checked:bg-primary checked:border-primary",
            "focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:outline-none",
          )}
        />
        {/* The tick is drawn over the input rather than by it, since an
            appearance-none checkbox has no mark of its own. */}
        <Check
          aria-hidden="true"
          className="text-primary-foreground pointer-events-none absolute size-3.5 opacity-0 peer-checked:opacity-100"
          strokeWidth={3}
        />
      </label>

      {editing ? (
        <Input
          aria-label="Edit title"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
            } else if (event.key === "Escape") {
              setDraft(todo.title);
              setEditing(false);
            }
          }}
          className="h-7 flex-1"
        />
      ) : (
        // A button so rename is keyboard-reachable, styled to read as plain
        // text.
        <button
          type="button"
          title="Click to rename"
          onClick={() => setEditing(true)}
          className={cn(
            "flex-1 cursor-text rounded px-1 py-0.5 text-left text-sm transition-colors",
            "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
            todo.done && "text-muted-foreground line-through",
          )}
        >
          {todo.title}
        </button>
      )}

      {/*
        Revealed on hover, but always present for keyboard and touch: hiding it
        with `hidden` would take it out of the tab order, and on a touch screen
        there is no hover to reveal it at all.
      */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Delete "${todo.title}"`}
        onClick={() => onRemove(todo.id)}
        className={cn(
          "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-7 shrink-0",
          "opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100",
        )}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
