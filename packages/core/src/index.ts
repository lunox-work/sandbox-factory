/**
 * The todo domain: what a todo is and what may be done to one. The API, web
 * app and extension all import these rules rather than restating them.
 *
 * Deliberately dependency-free, so it bundles for both the browser and the
 * VS Code host.
 */

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** ISO-8601. A string, not a Date, so it survives JSON transport. */
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
 * Trims a title and confirms it is usable, or throws. Surrounding whitespace
 * is fixed silently; empty after trimming is an error, since it would produce
 * an invisible row.
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

/** Returns `todo` with `done` flipped. Does not mutate the input. */
export function toggle(todo: Todo): Todo {
  return { ...todo, done: !todo.done };
}

/** Returns `todo` with a new, normalized title. Does not mutate the input. */
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

/**
 * Public handles, shared by user names and organization slugs. Their own
 * module because they are a second domain in this package, not part of the
 * todo rules above.
 */
export * from "./handle.js";
