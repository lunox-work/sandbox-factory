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
import { SideNav, type Screen } from "./SideNav";
import { SignIn } from "./SignIn";
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
  // A value rather than a router: there are two screens, each with a path.
  // Read from the path so a reload, a bookmark, or the return from a provider
  // link all land on the screen the URL names.
  const [screen, setScreen] = useState<Screen>(() =>
    screenForPath(window.location.pathname),
  );

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

  function navigate(next: Screen) {
    if (next === screen) {
      return;
    }
    // `pushState`, so each navigation is its own history entry and Back
    // returns to the previous screen rather than leaving the app.
    window.history.pushState(null, "", pathForScreen(next));
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
        {screen === "account" ? <Account /> : <Todos />}
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

function screenForPath(pathname: string): Screen {
  // Trailing slashes are equivalent: `/account/` is the same screen.
  return pathname.replace(/\/+$/, "") === ACCOUNT_PATH ? "account" : "todos";
}

function pathForScreen(screen: Screen): string {
  return screen === "account" ? ACCOUNT_PATH : "/";
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
