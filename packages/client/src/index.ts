/**
 * The typed API client, shared by the web dashboard and the VS Code extension.
 *
 * Platform-neutral on purpose: it uses `fetch` and nothing else. No `node:`
 * imports, no `window`, no `vscode`. That constraint is enforced by this
 * package's tsconfig (`types: []`) and is what lets one implementation serve a
 * browser bundle and the extension host. The previous generation of this code
 * was copy-pasted per client and the types drifted; this package exists so
 * that cannot happen again.
 *
 * Responses are parsed with the shared zod schemas rather than cast, so a
 * server that returns the wrong shape fails here with a clear message instead
 * of surfacing as `undefined` somewhere in a component.
 */

import {
  createTodoSchema,
  errorSchema,
  todoListSchema,
  todoSchema,
  updateTodoSchema,
  type CreateTodoInput,
  type TodoDto,
  type UpdateTodoInput,
} from "@sandbox-factory/shared";

export interface ClientOptions {
  /** Base URL of the API, e.g. `https://api.lunox.work`. Trailing slashes are fine. */
  baseUrl: string;
  /**
   * Returns the bearer token, or null when signed out. A function rather than
   * a string so the extension can read VS Code's secret storage lazily and the
   * web app can pick up a refreshed token without rebuilding the client.
   *
   * Returns `PromiseLike` rather than `Promise` so VS Code's `Thenable` —
   * which is what `context.secrets.get` hands back — satisfies it directly.
   */
  getToken?: () => string | null | PromiseLike<string | null>;
  /** Injectable for tests; defaults to the platform's global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Whether to send cookies. Defaults to `"include"`, because the web app
   * authenticates with a session cookie and the API is a different origin in
   * production (app.lunox.work calling api.lunox.work) — where fetch's own
   * default of `"same-origin"` would drop the cookie and turn every call into
   * a 401. The extension sends a bearer token instead and does not need this,
   * but including it costs nothing when there is no cookie to send.
   */
  credentials?: RequestCredentials;
}

/** An error carrying the HTTP status, so callers can branch on 401 vs 404. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The caller is signed out or the token expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * The todo is gone. Usually means someone else deleted it, so callers
   * generally want to drop it from their local list rather than show an error.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export class TodoClient {
  readonly #baseUrl: string;
  readonly #getToken: () => string | null | PromiseLike<string | null>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentials: RequestCredentials;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#getToken = options.getToken ?? (() => null);
    this.#credentials = options.credentials ?? "include";
    // Bound to globalThis: an unbound global fetch throws "Illegal invocation"
    // in browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const token = await this.#getToken();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (init?.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token !== null && token !== "") {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: this.#credentials,
      headers,
    });
    const text = await response.text();

    let payload: unknown = undefined;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(
          response.status,
          `Expected JSON from ${path}, got: ${text.slice(0, 200)}`,
        );
      }
    }

    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      throw new ApiError(
        response.status,
        parsed.success
          ? parsed.data.error
          : `HTTP ${response.status} from ${path}`,
      );
    }

    return payload;
  }

  async listTodos(): Promise<TodoDto[]> {
    const payload = await this.#request("/api/v1/todos");
    return todoListSchema.parse(payload).todos;
  }

  async getTodo(id: string): Promise<TodoDto> {
    const payload = await this.#request(
      `/api/v1/todos/${encodeURIComponent(id)}`,
    );
    return todoSchema.parse(payload);
  }

  async createTodo(input: CreateTodoInput): Promise<TodoDto> {
    // Validated before the request so a bad title is a local error, not a round trip.
    const body = createTodoSchema.parse(input);
    const payload = await this.#request("/api/v1/todos", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return todoSchema.parse(payload);
  }

  async updateTodo(id: string, input: UpdateTodoInput): Promise<TodoDto> {
    const body = updateTodoSchema.parse(input);
    const payload = await this.#request(
      `/api/v1/todos/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
    return todoSchema.parse(payload);
  }

  /** Convenience wrapper over {@link updateTodo} for the common case. */
  async setDone(id: string, done: boolean): Promise<TodoDto> {
    return this.updateTodo(id, { done });
  }

  /** Resolves on success; a missing todo raises an ApiError with status 404. */
  async deleteTodo(id: string): Promise<void> {
    await this.#request(`/api/v1/todos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
