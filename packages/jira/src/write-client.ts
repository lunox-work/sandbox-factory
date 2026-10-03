import { withDeadline } from "./transport.js";
import type { Credential } from "./credentials.js";
import { JiraApiError } from "./client.js";

export interface JiraWriteClientOptions {
  readonly credential: Credential;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Jira mutations with no automatic retry: a comment POST may already have landed. */
export class JiraWriteClient {
  readonly #credential: Credential;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number | undefined;

  constructor(options: JiraWriteClientOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async addComment(
    issueId: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const payload = await this.#request(
      `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
      "POST",
      { body },
      signal,
    );
    const id = asRecord(payload)?.["id"];
    if (typeof id !== "string" || id === "") {
      throw new JiraWriteResponseError("comment_id_missing");
    }
    return id;
  }

  async addLabel(
    issueId: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request(
      `/rest/api/3/issue/${encodeURIComponent(issueId)}`,
      "PUT",
      { update: { labels: [{ add: label }] } },
      signal,
    );
  }

  async #request(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return withDeadline(
      async (deadline) => {
        const response = await this.#fetch(
          `${this.#credential.baseUrl()}${path}`,
          {
            method,
            headers: {
              Authorization: await this.#credential.authorize(deadline),
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: deadline,
          },
        );
        if (!response.ok) {
          throw new JiraApiError(
            response.status,
            `Jira rejected the ${method}.`,
          );
        }
        if (response.status === 204) return undefined;
        try {
          return await response.json();
        } catch {
          throw new JiraWriteResponseError("invalid_success");
        }
      },
      signal,
      this.#timeoutMs,
    );
  }
}

export class JiraWriteResponseError extends Error {
  constructor(readonly code: "comment_id_missing" | "invalid_success") {
    super("Jira returned an invalid write response.");
    this.name = "JiraWriteResponseError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
