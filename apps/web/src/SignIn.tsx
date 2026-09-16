/**
 * The signed-out screen.
 *
 * Deliberately just the provider buttons: email and password is disabled on
 * the API, so offering a form here would produce a 400 from the server and no
 * account. The only thing this screen validates is the `?error=` the API
 * redirects back with — the providers own the whole credential flow.
 */

import { useEffect, useState } from "react";

import { PROVIDERS, signInWith, type ProviderId } from "./auth";

/**
 * The failures worth explaining, by Better Auth's error code.
 *
 * Only the ones a person can act on. Anything else gets the generic message:
 * a raw code like `state_mismatch` tells the user nothing and looks broken.
 */
const ERROR_MESSAGES: Record<string, string> = {
  // The provider's address already belongs to another account here. Merging
  // is refused rather than silently moving the address between accounts.
  account_not_linked:
    "That account's email address is already used by another account. Sign in with your original provider, then connect this one from your account page.",
  unable_to_link_account:
    "That account could not be connected. Sign in with your original provider, then try connecting it from your account page.",
  // The state cookie did not survive the round trip — usually a stale tab or
  // a sign-in left open long enough to expire.
  state_mismatch: "That sign-in attempt expired. Please try again.",
};

/**
 * A failed sign-in, read once from the URL.
 *
 * The API redirects callback failures here with `?error=<code>`, rather than
 * rendering Better Auth's own error page — that page lives on the API origin
 * and its "Go Home" link points at the API, which serves no UI.
 *
 * Read at module scope so the first render already has it: doing this in an
 * effect would flash the plain sign-in screen before the error appeared.
 */
function readErrorFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("error");
  if (code === null) {
    return null;
  }
  return (
    ERROR_MESSAGES[code] ?? "Sign-in could not be completed. Please try again."
  );
}

const initialError = readErrorFromUrl();

export function SignIn() {
  // Which provider is mid-redirect, so its button can show it. Not a boolean:
  // disabling every button but labelling only the one that was clicked is what
  // makes the wait legible.
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(initialError);

  // Drop the `?error=` once it has been read into state, so a refresh does not
  // resurrect an error the user has already seen and moved past.
  useEffect(() => {
    if (initialError !== null) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

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
