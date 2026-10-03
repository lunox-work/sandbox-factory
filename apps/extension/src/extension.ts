/**
 * VS Code extension entry point. The only workspace that may import `vscode`.
 * It reaches the API through @sandbox-factory/client, the same client the web
 * app uses, so an endpoint change lands in both at once.
 *
 * This file is the adapter: it wires the `vscode` API into the `Host` the
 * commands in `commands.ts` are written against, and registers them. The
 * logic is tested there without an extension host; nothing here decides
 * what runs.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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

import { extensionBuild } from "./build.js";
import { createTaskCommands } from "./commands.js";
import type { Host } from "./host.js";
import { resolveApiOrigin, tokenKeyFor } from "./origin.js";

/** Global state: the task folder `Open Task` is reopening the window into. */
const OPENED_FOLDER_KEY = "sandboxFactory.openedFolder";

export function activate(context: vscode.ExtensionContext): void {
  // An output channel, not a notification: it must still be there when someone
  // goes looking.
  const output = vscode.window.createOutputChannel("sandbox-factory");
  output.appendLine(buildBanner("sandbox-factory", extensionBuild));

  /**
   * The API origin, from user or application settings only, and the token
   * bound to it. A repository's workspace settings cannot redirect an
   * authenticated request to another host.
   */
  const resolved = resolveApiOrigin(
    vscode.workspace
      .getConfiguration("sandboxFactory")
      .inspect<string>("apiBaseUrl"),
  );
  if (resolved.overrideIgnored)
    output.appendLine(
      "Ignoring a workspace-level sandboxFactory.apiBaseUrl: the API address is a user setting.",
    );
  if (resolved.invalid)
    output.appendLine(
      `sandboxFactory.apiBaseUrl is not an http(s) URL; using ${resolved.origin}.`,
    );
  const origin = resolved.origin;
  const tokenKey = tokenKeyFor(origin);

  const client = new ApiClient({
    baseUrl: origin,
    getToken: () =>
      context.secrets.get(tokenKey).then((token) => token ?? null),
  });
  void client;

  const host: Host = {
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? []).map(
        (folder) => folder.uri.fsPath,
      ),
    isTrusted: () => vscode.workspace.isTrusted,
    // Absent is `null`; a file that exists but cannot be read is an error
    // the command reports, not "no sandbox-task.json".
    readFile: (path) =>
      readFile(path, "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" || error.code === "ENOTDIR"
          ? null
          : Promise.reject(error),
      ),
    pick: (items, placeHolder) =>
      Promise.resolve(vscode.window.showQuickPick([...items], { placeHolder })),
    input: (prompt, placeHolder) =>
      Promise.resolve(
        vscode.window.showInputBox({
          prompt,
          placeHolder,
          ignoreFocusOut: true,
        }),
      ),
    pickFolder: async (title) => {
      const picked = await vscode.window.showOpenDialog({
        title,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      return picked?.[0]?.fsPath;
    },
    clone: (url, destination) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["clone", "--", url, destination], (error) =>
          error === null ? resolve() : reject(error),
        );
      }),
    openFolder: async (path) => {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(path),
        {
          forceNewWindow: false,
        },
      );
    },
    rememberOpened: (folder) =>
      Promise.resolve(context.globalState.update(OPENED_FOLDER_KEY, folder)),
    openedFolder: () => context.globalState.get<string>(OPENED_FOLDER_KEY),
    runInTerminal: (name, cwd, command) => {
      const terminal = vscode.window.createTerminal({ name, cwd });
      terminal.show(true);
      terminal.sendText(command, true);
    },
    info: (message) => void vscode.window.showInformationMessage(message),
    warn: (message) => void vscode.window.showWarningMessage(message),
    error: (message) => void vscode.window.showErrorMessage(message),
    log: (line) => output.appendLine(line),
  };
  const tasks = createTaskCommands(host);
  void tasks.announceOpened();

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("sandboxFactory.openTask", () =>
      tasks.openTask(),
    ),
    vscode.commands.registerCommand("sandboxFactory.showTask", () =>
      tasks.showTask(),
    ),
    vscode.commands.registerCommand("sandboxFactory.installDependencies", () =>
      tasks.installDependencies(),
    ),
    vscode.commands.registerCommand("sandboxFactory.runApp", () =>
      tasks.runApp(),
    ),
    vscode.commands.registerCommand("sandboxFactory.runTests", () =>
      tasks.runTests(),
    ),

    /**
     * Reports this build and the API's. The two can drift by days: the
     * extension updates only when the marketplace ships it and the user
     * accepts it.
     */
    vscode.commands.registerCommand("sandboxFactory.showVersion", async () => {
      const api = await fetchApiBuild(origin);
      output.appendLine(buildBanner("sandbox-factory", extensionBuild));
      output.appendLine(
        api === undefined
          ? `API at ${origin} did not report a version.`
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
     * Stores the bearer token the API issues, bound to the configured
     * origin. The extension has no cookie jar, so the session the web app
     * keeps in a cookie reaches here as a token the user pastes in; usable
     * sign-in arrives with contributor submission.
     */
    vscode.commands.registerCommand("sandboxFactory.signIn", async () => {
      const token = await vscode.window.showInputBox({
        prompt: `Paste an API token for ${origin}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) {
        return;
      }
      if (token === "") {
        await context.secrets.delete(tokenKey);
        void vscode.window.showInformationMessage(
          "sandbox-factory: token cleared.",
        );
        return;
      }
      await context.secrets.store(tokenKey, token);
      void vscode.window.showInformationMessage(
        `sandbox-factory: token saved for ${origin}.`,
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
          .then(
            (choice) => {
              if (choice === "Reload") {
                void vscode.commands.executeCommand(
                  "workbench.action.reloadWindow",
                );
              }
            },
            () => {},
          );
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
async function fetchApiBuild(
  origin: string,
): Promise<BuildInfoDto | undefined> {
  try {
    const response = await fetch(new URL("/version", origin));
    if (!response.ok) {
      return undefined;
    }
    const parsed = buildInfoSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs an API call and reports failure readably: a 401 means the token is
 * stale, a 404 means someone else already changed it. Kept for the data
 * commands that submission adds.
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
