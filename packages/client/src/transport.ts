import { errorSchema } from "@sandbox-factory/shared";

export interface ClientOptions {
  /** Base URL, e.g. `https://api.lunox.work`. Trailing slashes are fine. */
  baseUrl: string;
  /**
   * Returns the bearer token, or null when signed out. A function so the
   * token is read lazily and can change without rebuilding the client.
   * `PromiseLike`, not `Promise`, so VS Code's `Thenable` from
   * `context.secrets.get` satisfies it.
   */
  getToken?: () => string | null | PromiseLike<string | null>;
  /** Injectable for tests; defaults to the platform's global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Whether to send cookies. Defaults to `"include"`: the web app uses a
   * session cookie and the API is a different origin in production, where
   * fetch's default `"same-origin"` would drop it and make every call a 401.
   */
  credentials?: RequestCredentials;
}

/** An error carrying the HTTP status, so callers can branch on 401 vs 404. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The route's stable reason (`run_limit`, `graph_failed`, …), if it gave one. */
    readonly code: string | null = null,
    /** Original error envelope, including current revisions for conflicts. */
    readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The caller is signed out or the token expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * The resource is gone, usually removed from another client; callers
   * generally drop it from their local list rather than show an error.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/**
 * Strips trailing slashes in linear time. Do not simplify to
 * `replace(/\/+$/, "")`: that is quadratic on a long run of slashes not at the
 * end (80k took ~2.3s), and `baseUrl` comes from callers of a published
 * package. Pinned by the slash tests in client.test.ts.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #getToken: () => string | null | PromiseLike<string | null>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentials: RequestCredentials;

  constructor(options: ClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#getToken = options.getToken ?? (() => null);
    this.#credentials = options.credentials ?? "include";
    // Bound to globalThis: an unbound global fetch throws "Illegal invocation"
    // in browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One request, authenticated and parsed. `protected` rather than private:
   * this is the seam a subclass builds endpoints on, and the reason the
   * transport lives in a package rather than in each surface.
   */
  async #send(path: string, init?: RequestInit): Promise<Response> {
    init?.signal?.throwIfAborted();
    const token = await abortable(
      Promise.resolve(this.#getToken()),
      init?.signal,
    );
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init?.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token !== null && token !== "") {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return abortable(
      this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        credentials: this.#credentials,
        headers,
      }),
      init?.signal,
    );
  }

  protected async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#send(path, init);
    const text = await abortable(response.text(), init?.signal);
    init?.signal?.throwIfAborted();

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
        parsed.success ? (parsed.data.code ?? null) : null,
        payload,
      );
    }

    return payload;
  }
}

/** Bound cancellation even for injected transports that ignore fetch's signal. */
async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal == null) return promise;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
