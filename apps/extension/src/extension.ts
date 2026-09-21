/**
 * VS Code extension entry point. The only workspace that may import `vscode`.
 * It reaches the API through @sandbox-factory/client, the same client the web
 * app uses, so an endpoint change lands in both at once.
 *
 * **This is a shell.** The todo tree and its commands were removed with the
 * todo domain; what remains is everything a feature needs and would otherwise
 * have to rebuild — activation, the output channel, the secret-backed token,
 * a configured client, the version command and the reload-on-config-change
 * handler. `Show Version` is deliberately kept as a working command: it proves
 * the extension activates and can reach the API, which is the first thing to
 * check when the next feature does not.
 */

import { ApiClient, ApiError } from "@sandbox-factory/client";
import {
  buildBanner,
  buildInfoSchema,
  commitUrl,
  formatVersion,
  sameBuild,
  type BuildInfoDto,
} from "@sandbox-factory/shared";
import * as vscode from "vscode";

import { extensionBuild } from "./build";

/**
 * Key for the bearer token in `context.secrets`, which VS Code encrypts. A
 * setting would put it in plaintext settings.json.
 */
const TOKEN_KEY = "sandboxFactory.token";

export function activate(context: vscode.ExtensionContext): void {
  // An output channel, not a notification: it must still be there when someone
  // goes looking.
  const output = vscode.window.createOutputChannel("sandbox-factory");
  output.appendLine(buildBanner("sandbox-factory", extensionBuild));

  /**
   * The API client, ready for the first feature to call.
   *
   * Built here rather than where it is first needed so the token and base URL
   * are read in one place. `void` marks it as deliberately unused for now —
   * removing it would mean rebuilding the auth wiring from scratch.
   */
  const client = new ApiClient({
    baseUrl: baseUrl(),
    getToken: () =>
      context.secrets.get(TOKEN_KEY).then((token) => token ?? null),
  });
  void client;

  context.subscriptions.push(
    output,

    /**
     * Reports this build and the API's. The two can drift by days: the
     * extension updates only when the marketplace ships it and the user
     * accepts it.
     */
    vscode.commands.registerCommand("sandboxFactory.showVersion", async () => {
      const api = await fetchApiBuild();
      output.appendLine(buildBanner("sandbox-factory", extensionBuild));
      output.appendLine(
        api === undefined
          ? `API at ${baseUrl()} did not report a version.`
          : buildBanner("API", api),
      );
      output.show(true);

      const link = commitUrl(extensionBuild);
      const detail =
        api !== undefined && !sameBuild(extensionBuild, api)
          ? ` · API ${formatVersion(api)}`
          : "";
      const choice = await vscode.window.showInformationMessage(
        `sandbox-factory ${formatVersion(extensionBuild)}${detail}`,
        ...(link === undefined ? [] : ["View commit"]),
      );
      if (choice === "View commit" && link !== undefined) {
        await vscode.env.openExternal(vscode.Uri.parse(link));
      }
    }),

    /**
     * Stores the bearer token the API issues, which is how this extension
     * authenticates: it has no cookie jar, so the session the web app keeps in
     * a cookie reaches here as a token the user pastes in.
     *
     * Kept with no feature calling it yet because it writes to `secrets`, and
     * the wrong storage for a credential is the kind of shortcut that gets
     * taken when a feature is mid-flight.
     */
    vscode.commands.registerCommand("sandboxFactory.signIn", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste an API token",
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) {
        return;
      }
      if (token === "") {
        await context.secrets.delete(TOKEN_KEY);
        void vscode.window.showInformationMessage(
          "sandbox-factory: token cleared.",
        );
        return;
      }
      await context.secrets.store(TOKEN_KEY, token);
      void vscode.window.showInformationMessage(
        "sandbox-factory: token saved.",
      );
    }),

    // A changed base URL needs a new client, which means a reload.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sandboxFactory.apiBaseUrl")) {
        vscode.window
          .showInformationMessage(
            "sandbox-factory: API URL changed. Reload to apply.",
            "Reload",
          )
          .then((choice) => {
            if (choice === "Reload") {
              void vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
            }
          });
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is registered on the context.
}

/**
 * Asks the configured API what it is running. Undefined on any failure, like
 * the web app's equivalent.
 *
 * Not routed through `ApiClient`: /version sits outside /api/v1 and needs no
 * session, and that client sends credentials on every call.
 */
async function fetchApiBuild(): Promise<BuildInfoDto | undefined> {
  try {
    const response = await fetch(new URL("/version", baseUrl()));
    if (!response.ok) {
      return undefined;
    }
    const parsed = buildInfoSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function baseUrl(): string {
  return vscode.workspace
    .getConfiguration("sandboxFactory")
    .get<string>("apiBaseUrl", "http://localhost:4000");
}

/**
 * Runs an API call and reports failure readably.
 *
 * Unused while the shell has no data commands, but kept and exported: it
 * encodes the two cases every call has to handle — a 401 means the token is
 * stale, a 404 means someone else already changed it — and rediscovering that
 * per command is how inconsistent error messages happen.
 */
export async function run(
  action: () => Promise<unknown>,
  onDone?: () => void,
): Promise<void> {
  try {
    await action();
    onDone?.();
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) {
      // Already gone elsewhere; refreshing is the whole fix.
      onDone?.();
      return;
    }
    const message =
      error instanceof ApiError && error.isUnauthorized
        ? "sign-in required."
        : error instanceof Error
          ? error.message
          : "Something went wrong.";
    void vscode.window.showErrorMessage(`sandbox-factory: ${message}`);
  }
}
