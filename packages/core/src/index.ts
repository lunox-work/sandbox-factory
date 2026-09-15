/**
 * The todo domain: what a todo is, and the rules about what may be done to one.
 *
 * This package is the one place those rules live. The API enforces them on
 * write, the web app and the extension use them to decide what to render and
 * what to disable, and all three import this module rather than restating it —
 * a rule changed here changes everywhere without a second edit.
 *
 * It deliberately has no dependencies: no database, no HTTP, no validation
 * library. That is what lets the extension bundle it for the VS Code host and
 * the browser bundle it for the dashboard.
 */

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** ISO-8601. String rather than Date so it survives JSON transport unchanged. */
  readonly createdAt: string;
}

export const TITLE_MAX_LENGTH = 200;

/** The three views the UI offers. */
export const TODO_FILTERS = ["all", "active", "completed"] as const;

export type TodoFilter = (typeof TODO_FILTERS)[number];

export function isTodoFilter(value: unknown): value is TodoFilter {
  return (
    typeof value === "string" &&
    (TODO_FILTERS as readonly string[]).includes(value)
  );
}

export class InvalidTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTitleError";
  }
}

/**
 * Trim a title and confirm it is usable, or throw.
 *
 * Titles are trimmed rather than rejected for surrounding whitespace: a user
 * who types a trailing space means the same todo, and silently fixing it is
 * kinder than an error. Empty-after-trimming is a real error, though — it would
 * produce an invisible row.
 */
export function normalizeTitle(raw: string): string {
  const title = raw.trim();
  if (title === "") {
    throw new InvalidTitleError("A todo needs a title.");
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new InvalidTitleError(
      `Titles are capped at ${TITLE_MAX_LENGTH} characters.`,
    );
  }
  return title;
}

/** Whether `raw` would be accepted by {@link normalizeTitle}. */
export function isValidTitle(raw: string): boolean {
  const title = raw.trim();
  return title !== "" && title.length <= TITLE_MAX_LENGTH;
}

/** Return `todo` with `done` flipped. Does not mutate the input. */
export function toggle(todo: Todo): Todo {
  return { ...todo, done: !todo.done };
}

/** Return `todo` with a new title, normalized. Does not mutate the input. */
export function rename(todo: Todo, title: string): Todo {
  return { ...todo, title: normalizeTitle(title) };
}

export function matchesFilter(todo: Todo, filter: TodoFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return !todo.done;
    case "completed":
      return todo.done;
  }
}

export function filterTodos(
  todos: readonly Todo[],
  filter: TodoFilter,
): Todo[] {
  return todos.filter((todo) => matchesFilter(todo, filter));
}

export interface TodoCounts {
  readonly total: number;
  readonly active: number;
  readonly completed: number;
}

export function countTodos(todos: readonly Todo[]): TodoCounts {
  const completed = todos.filter((todo) => todo.done).length;
  return {
    total: todos.length,
    active: todos.length - completed,
    completed,
  };
}
