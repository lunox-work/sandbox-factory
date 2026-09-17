/**
 * Todo list state. Hand-rolled rather than TanStack Query, which is more
 * dependency than value for one resource; swap it in when caching or
 * optimistic updates across several resources start being written by hand.
 */

import { ApiError } from "@sandbox-factory/client";
import type { TodoDto } from "@sandbox-factory/shared";
import { useCallback, useEffect, useState } from "react";

import { api } from "./api";

interface State {
  todos: TodoDto[];
  error: string | null;
  loading: boolean;
}

export function useTodos() {
  const [state, setState] = useState<State>({
    todos: [],
    error: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const todos = await api.listTodos();
      setState({ todos, error: null, loading: false });
    } catch (error) {
      // On a 401 drop the list, rather than leaving the previous user's todos
      // on screen under an error message.
      setState((s) => ({
        todos: isUnauthorized(error) ? [] : s.todos,
        error: describe(error),
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (title: string) => {
    try {
      const created = await api.createTodo({ title });
      setState((s) => ({
        todos: [created, ...s.todos],
        error: null,
        loading: false,
      }));
    } catch (error) {
      setState((s) => ({ ...s, error: describe(error) }));
    }
  }, []);

  const setDone = useCallback(async (id: string, done: boolean) => {
    try {
      const updated = await api.setDone(id, done);
      setState((s) => ({
        ...s,
        todos: s.todos.map((todo) => (todo.id === id ? updated : todo)),
        error: null,
      }));
    } catch (error) {
      setState((s) => dropIfGone(s, id, error));
    }
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    try {
      const updated = await api.updateTodo(id, { title });
      setState((s) => ({
        ...s,
        todos: s.todos.map((todo) => (todo.id === id ? updated : todo)),
        error: null,
      }));
    } catch (error) {
      setState((s) => dropIfGone(s, id, error));
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteTodo(id);
      setState((s) => ({
        ...s,
        todos: s.todos.filter((todo) => todo.id !== id),
        error: null,
      }));
    } catch (error) {
      setState((s) => dropIfGone(s, id, error));
    }
  }, []);

  return { ...state, refresh, create, setDone, rename, remove };
}

/** A 404 means it was already deleted elsewhere: drop the row silently. */
function dropIfGone(state: State, id: string, error: unknown): State {
  if (error instanceof ApiError && error.isNotFound) {
    return {
      ...state,
      todos: state.todos.filter((todo) => todo.id !== id),
      error: null,
    };
  }
  return { ...state, error: describe(error) };
}

/** The session is gone: expired, revoked, or signed out in another tab. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthorized;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}
