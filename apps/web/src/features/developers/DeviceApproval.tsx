/**
 * `/device`: where a signed-in person approves a command-line client's
 * device sign-in (`duediligence login`, `carveout login`).
 *
 * The client shows a code and opens this page with it in `?user_code=`;
 * a person can also type it. Looking the code up claims it for whoever is
 * signed in, and only then does Better Auth say which client asked. What
 * the approval gives the client is narrow: its session may only mint that
 * client's workspace API token, in a workspace the person owns or
 * administers, with at most the client's scopes (`CLI_CLIENTS` in core).
 *
 * A page of its own, outside the shell, like a version's files.
 */

import { useState } from "react";
import { cliScopes, isCliClient } from "sandbox-factory";

import { ErrorBanner } from "@/components/Message";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { authClient } from "../../auth";

type Step =
  | { kind: "enter" }
  | { kind: "review"; code: string; client: string }
  | { kind: "done"; approved: boolean };

/** What Better Auth's device errors mean to the person holding the code. */
function explain(error: { error?: string; message?: string } | null): string {
  switch (error?.error) {
    case "expired_token":
      return "That code has expired. Start the sign-in again in your terminal.";
    case "invalid_request":
      return "That code is not one we issued, or it was already used.";
    default:
      return error?.message ?? "That code could not be checked. Try again.";
  }
}

/** The code as typed: case and dashes do not matter. */
function normalize(code: string): string {
  return code.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

export function DeviceApprovalPage({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function lookUp() {
    const userCode = normalize(code);
    if (userCode === "") return;
    setPending(true);
    setError(null);
    const result = await authClient.device({ query: { user_code: userCode } });
    setPending(false);
    if (result.error !== null) {
      setError(explain(result.error));
      return;
    }
    if (result.data.status !== "pending") {
      setError("That code was already approved or denied.");
      return;
    }
    setStep({
      kind: "review",
      code: userCode,
      client: result.data.client_id ?? "",
    });
  }

  async function decide(code: string, approve: boolean) {
    setPending(true);
    setError(null);
    const result = approve
      ? await authClient.device.approve({ userCode: code })
      : await authClient.device.deny({ userCode: code });
    setPending(false);
    if (result.error !== null) {
      setError(explain(result.error));
      return;
    }
    setStep({ kind: "done", approved: approve });
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>Sign in a command-line tool</h1>
          </CardTitle>
          <CardDescription>
            Approve only a sign-in you started in your own terminal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error !== null && <ErrorBanner>{error}</ErrorBanner>}
          {step.kind === "enter" && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void lookUp();
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm">
                The code your terminal shows
                <Input
                  value={code}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <Button
                type="submit"
                disabled={pending || normalize(code) === ""}
              >
                Continue
              </Button>
            </form>
          )}
          {step.kind === "review" && (
            <div className="flex flex-col gap-3 text-sm">
              <p>
                <strong>{step.client}</strong> asks to sign in as you. It will
                be able to make itself an API token, in a workspace you own or
                administer, that can:
              </p>
              <ul className="list-disc pl-5 font-mono text-xs">
                {(isCliClient(step.client) ? cliScopes(step.client) : []).map(
                  (scope) => (
                    <li key={scope}>{scope}</li>
                  ),
                )}
              </ul>
              <div className="flex gap-2">
                <Button
                  disabled={pending}
                  onClick={() => void decide(step.code, true)}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void decide(step.code, false)}
                >
                  Deny
                </Button>
              </div>
            </div>
          )}
          {step.kind === "done" && (
            <p className="text-sm" role="status">
              {step.approved
                ? "Approved. Return to your terminal to finish."
                : "Denied. Nothing was signed in."}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
