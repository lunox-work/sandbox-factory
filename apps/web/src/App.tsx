import type { TodoDto } from "@sandbox-factory/shared";
import {
  TODO_FILTERS,
  countTodos,
  filterTodos,
  isValidTitle,
  type TodoFilter,
} from "sandbox-factory";
import { useState, type FormEvent } from "react";

import { Account } from "./Account";
import { signOut, useSession } from "./auth";
import { BuildFooter } from "./BuildFooter";
import { SignIn } from "./SignIn";
import { useTodos } from "./useTodos";

export function App() {
  const { data: session, isPending } = useSession();

  // Three states, not two: rendering sign-in while the session resolves would
  // flash it at a signed-in user on every reload.
  if (isPending) {
    return (
      <main className="app">
        <p className="muted">Loading…</p>
        <BuildFooter />
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
  return <Signed key={session.user.id} name={session.user.name} />;
}

function Signed({ name }: { name: string }) {
  // A boolean rather than a router: there are two screens. Seeded from the
  // query string so returning from a provider link lands back on settings.
  const [showAccount, setShowAccount] = useState(
    () => new URLSearchParams(window.location.search).get("account") === "1",
  );

  return showAccount ? (
    <Account
      onClose={() => {
        // Drop the marker so a later reload does not reopen settings.
        window.history.replaceState(null, "", window.location.pathname);
        setShowAccount(false);
      }}
    />
  ) : (
    <Todos name={name} onAccount={() => setShowAccount(true)} />
  );
}

function Todos({ name, onAccount }: { name: string; onAccount: () => void }) {
  const { todos, error, loading, create, setDone, rename, remove } = useTodos();
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");

  // Both from packages/core, shared with the extension, so the two surfaces
  // cannot disagree about what "active" means.
  const visible = filterTodos(todos, filter);
  const counts = countTodos(todos);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTitle(title)) {
      return;
    }
    void create(title);
    setTitle("");
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Todos</h1>
        <div className="session">
          <span className="counts">
            {counts.active} active · {counts.completed} done
          </span>
          <button type="button" className="linklike" onClick={onAccount}>
            {name}
          </button>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <form className="create" onSubmit={onSubmit}>
        <input
          aria-label="Todo title"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" disabled={!isValidTitle(title)}>
          Add
        </button>
      </form>

      <nav className="filters">
        {TODO_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            className={option === filter ? "active" : ""}
            aria-pressed={option === filter}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
      </nav>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {visible.length === 0 && !loading ? (
        <p className="empty">
          {todos.length === 0
            ? "Nothing here yet. Add something above."
            : `No ${filter} todos.`}
        </p>
      ) : (
        <ul className="list">
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

      <BuildFooter />
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
    <li className={todo.done ? "row done" : "row"}>
      <input
        type="checkbox"
        checked={todo.done}
        aria-label={`Mark "${todo.title}" as ${todo.done ? "not done" : "done"}`}
        onChange={(event) => onToggle(todo.id, event.target.checked)}
      />

      {editing ? (
        <input
          className="edit"
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
        />
      ) : (
        <button
          type="button"
          className="title"
          title="Click to rename"
          onClick={() => setEditing(true)}
        >
          {todo.title}
        </button>
      )}

      <button
        type="button"
        className="delete"
        aria-label={`Delete "${todo.title}"`}
        onClick={() => onRemove(todo.id)}
      >
        ×
      </button>
    </li>
  );
}
