/**
 * Account settings: your handle, and the providers you sign in with.
 *
 * There is no separate "email addresses" list: an address exists only because
 * a provider vouched for it, and linking is the only way to add one.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { PROVIDERS, authClient, type ProviderId } from "./auth";

interface ProvenEmail {
  id: string;
  email: string;
  /** Every provider that vouched for this address, often more than one. */
  providers: string[];
  isPrimary: boolean;
}

interface LinkedAccount {
  /**
   * Better Auth's row id. `unlinkAccount` matches on this, not on `accountId`
   * below — passing that one 400s.
   */
  id: string;
  providerId: string;
  /** The user's id at the provider, e.g. a GitHub numeric id. Display only. */
  accountId: string;
}

export function Account({ onClose }: { onClose: () => void }) {
  const [emails, setEmails] = useState<ProvenEmail[]>([]);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [emailRes, meRes, accountRes] = await Promise.all([
        fetch("/api/v1/me/emails", { credentials: "include" }),
        fetch("/api/v1/me", { credentials: "include" }),
        authClient.listAccounts(),
      ]);
      if (emailRes.ok) {
        setEmails(
          ((await emailRes.json()) as { emails: ProvenEmail[] }).emails,
        );
      }
      if (meRes.ok) {
        const body = (await meRes.json()) as {
          user: { id: string; username: string | null };
        };
        setUsername(body.user.username);
        setAccountId(body.user.id);
      }
      setAccounts((accountRes.data ?? []) as unknown as LinkedAccount[]);
      setError(null);
    } catch {
      setError("Could not load your account.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const linked = new Map(
    accounts.map((account) => [account.providerId, account] as const),
  );

  async function link(provider: ProviderId) {
    setBusy(true);
    setError(null);
    try {
      await authClient.linkSocial({
        provider,
        callbackURL: `${window.location.origin}?account=1`,
      });
    } catch {
      setError("Could not start linking. Please try again.");
      setBusy(false);
    }
  }

  /**
   * Runs an action on one address and reloads, showing the server's reason
   * verbatim if it refuses.
   */
  async function actOnEmail(path: string, method: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method, credentials: "include" });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        // Return rather than refresh: `refresh` clears the error on success,
        // which would wipe the message just set.
        setError(body?.error ?? "That did not work.");
        return;
      }
      await refresh();
    } catch {
      setError("That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(id: string) {
    setBusy(true);
    setError(null);
    try {
      // `id` is Better Auth's row id; see `LinkedAccount.id`.
      const result = await authClient.unlinkAccount({ accountId: id });
      if (result.error !== null && result.error !== undefined) {
        // The server's message ("can't unlink your last account") is one the
        // person can act on.
        setError(result.error.message ?? "Could not unlink that account.");
        return;
      }
      await refresh();
    } catch {
      setError("Could not unlink that account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Account</h1>
        <button type="button" onClick={onClose}>
          Back to todos
        </button>
      </header>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <UsernameForm
        current={username}
        accountId={accountId}
        busy={busy}
        onSaved={(next) => setUsername(next)}
        onBusy={setBusy}
      />

      <section className="panel">
        <h2>Email addresses</h2>
        <p className="muted small">
          Each address is proved by an account you connected. The primary one is
          how we reach you. Disconnecting an account releases the address it
          proved, freeing it for someone else.
        </p>

        <ul className="list">
          {emails.map((entry) => (
            <li key={entry.id} className="email">
              {/*
                The address heads its block and each account proving it gets
                its own line, so each button sits next to its provider.
              */}
              <div className="email-head">
                <span className="title">
                  {entry.email}
                  {entry.isPrimary && <span className="badge">primary</span>}
                </span>
                {/*
                  No "remove address" action: a connected account proves the
                  address, so the next sign-in would restore it. Disconnecting
                  the account is what releases it.
                */}
                {!entry.isPrimary && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void actOnEmail(
                        `/api/v1/me/emails/${entry.id}/primary`,
                        "POST",
                      )
                    }
                  >
                    Make primary
                  </button>
                )}
              </div>

              <ul className="providers-list">
                {entry.providers.map((providerId) => {
                  const account = linked.get(providerId);
                  return (
                    <li key={providerId} className="row provider-row">
                      <span className="title muted small">{providerId}</span>
                      {account !== undefined && (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy || accounts.length < 2}
                          title={
                            accounts.length < 2
                              ? "This is your only way to sign in."
                              : undefined
                          }
                          onClick={() => void unlink(account.id)}
                        >
                          Disconnect
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        {/*
          Providers with nothing connected yet. Listed with the addresses
          because connecting one is how an address gets added.
        */}
        {PROVIDERS.some((provider) => !linked.has(provider.id)) && (
          <ul className="list">
            {PROVIDERS.filter((provider) => !linked.has(provider.id)).map(
              (provider) => {
                const label = provider.label.replace("Continue with ", "");
                return (
                  <li key={provider.id} className="row">
                    <span className="title">
                      <strong>{label}</strong>
                      <span className="muted small">
                        {" "}
                        not connected — connect it to add its address
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void link(provider.id)}
                    >
                      Connect
                    </button>
                  </li>
                );
              },
            )}
          </ul>
        )}
      </section>
    </main>
  );
}

function UsernameForm({
  current,
  accountId,
  busy,
  onSaved,
  onBusy,
}: {
  current: string | null;
  accountId: string | null;
  busy: boolean;
  onSaved: (username: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Seed the field once the handle arrives; `current` is null until then.
  useEffect(() => {
    setDraft(current ?? "");
  }, [current]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/me/username", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: draft }),
      });
      const body = (await res.json().catch(() => null)) as {
        username?: string;
        error?: string;
      } | null;
      if (res.ok && body?.username !== undefined) {
        onSaved(body.username);
        setFailed(false);
        setMessage("Saved.");
      } else {
        setFailed(true);
        setMessage(body?.error ?? "Could not save that username.");
      }
    } catch {
      setFailed(true);
      setMessage("Could not save that username.");
    } finally {
      onBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Username</h2>
      <p className="muted small">
        Your public handle. You can change it whenever you like, as long as it
        is not taken.
      </p>
      <form className="create" onSubmit={(event) => void submit(event)}>
        <input
          aria-label="Username"
          placeholder="your-handle"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(null);
          }}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          Save
        </button>
      </form>
      {message !== null && (
        <p className={failed ? "error small" : "muted small"} role="status">
          {message}
        </p>
      )}

      {accountId !== null && (
        <p className="muted small idline">
          Account ID <code>{accountId}</code>
          <br />
          This never changes, even when you rename your handle.
        </p>
      )}
    </section>
  );
}
