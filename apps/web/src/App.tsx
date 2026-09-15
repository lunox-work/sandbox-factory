import type { TodoDto } from "@sandbox-factory/shared";
import {
  TODO_FILTERS,
  countTodos,
  filterTodos,
  isValidTitle,
  type TodoFilter,
} from "sandbox-factory";
import { useState, type FormEvent } from "react";

import { useTodos } from "./useTodos";

export function App() {
  const { todos, error, loading, create, setDone, rename, remove } = useTodos();
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");

  // Both from packages/core — the same functions the extension uses, so the
  // two surfaces cannot disagree about what "active" means.
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
        <span className="counts">
          {counts.active} active · {counts.completed} done
        </span>
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
    // An unchanged or unusable draft is a cancel, not an error: the user
    // clicked away, which is not a request to save something invalid.
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
