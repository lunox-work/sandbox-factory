/**
 * Account settings: your handle, and the providers you sign in with.
 *
 * There is no separate "email addresses" list. An address exists here only
 * because a provider vouched for it, so showing it *on* the provider row says
 * the same thing without implying emails are managed independently — which
 * they are not, since there is no way to add one except by linking.
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
   * Better Auth's own row id. This is what `unlinkAccount` matches on, and it
   * is *not* `accountId` below — passing that one silently 400s.
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
   * Runs an action on one address and reloads.
   *
   * Shared by "make primary" and "remove" because both are a one-shot call
   * whose only interesting outcome is the refreshed list — or the server's
   * reason for refusing, which is worth showing verbatim.
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
        // which would wipe the message that was just set and leave the person
        // with a silently failed action.
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
      // `id` is Better Auth's row id, not the provider's `accountId` — the
      // endpoint matches on the former and rejects the latter.
      const result = await authClient.unlinkAccount({ accountId: id });
      if (result.error !== null && result.error !== undefined) {
        // Surface what the server said rather than a generic failure: the
        // useful cases here ("can't unlink your last account") are ones the
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
                The address heads its own block, and each account that proves
                it gets a line underneath. Listing the providers inline instead
                ran them together — "via google, github" followed by two
                buttons on one row is hard to read, and it is not obvious which
                button belongs to which provider.
              */}
              <div className="email-head">
                <span className="title">
                  {entry.email}
                  {entry.isPrimary && <span className="badge">primary</span>}
                </span>
                {/*
                  The primary offers no promote action: promoting it again is
                  a no-op. There is no "remove address" action at all — an
                  address exists because a connected account proves it, so
                  deleting the row while that account stays connected would be
                  undone by the next sign-in. Disconnecting is what releases it.
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
          Providers with nothing connected yet. They sit below the addresses
          rather than in a section of their own, because connecting one is how
          an address gets added — it is the same story, not a separate one.
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

  // Seed the field once the current handle arrives; `current` is null until
  // the first fetch resolves.
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
