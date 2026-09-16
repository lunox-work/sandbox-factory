/**
 * The signed-out screen.
 *
 * Deliberately just the two provider buttons: email and password is disabled
 * on the API, so offering a form here would produce a 400 from the server and
 * no account. There is nothing to validate on this screen — the providers own
 * the whole credential flow.
 */

import { useState } from "react";

import { PROVIDERS, signInWith, type ProviderId } from "./auth";

export function SignIn() {
  // Which provider is mid-redirect, so its button can show it. Not a boolean:
  // with two buttons, disabling both but labelling only the one that was
  // clicked is what makes the wait legible.
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(provider: ProviderId) {
    setPending(provider);
    setError(null);
    try {
      await signInWith(provider);
      // On success the browser navigates away, so there is no success branch
      // to write here — reaching the next line at all means it did not.
    } catch {
      setError("Could not start sign-in. Please try again.");
      setPending(null);
    }
  }

  return (
    <main className="app signin">
      <h1>Todos</h1>
      <p className="muted">Sign in to see your todos.</p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="providers">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="provider"
            disabled={pending !== null}
            onClick={() => void start(provider.id)}
          >
            {pending === provider.id ? "Redirecting…" : provider.label}
          </button>
        ))}
      </div>
    </main>
  );
}
