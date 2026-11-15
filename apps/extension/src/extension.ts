/**
 * VS Code extension entry point. The only workspace that may import `vscode`.
 * It reaches the API through @sandbox-factory/client, the same client the web
 * app uses, so an endpoint change lands in both at once.
 *
 * This file is the adapter: it wires the `vscode` API into the `Host` the
 * commands in `commands.ts` and `contribute.ts` are written against, and
 * registers them. The logic is tested there without an extension host;
 * nothing here decides what runs.
 */

import { readFile } from "node:fs/promises";
import { ContributorClient } from "@sandbox-factory/client";
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
import { createContributeCommands } from "./contribute.js";
import type { Host } from "./host.js";
import { resolvePlatformOrigin, tokenKeyFor } from "./origin.js";

/** Global state: the task folder `Open Task` is reopening the window into. */
const OPENED_FOLDER_KEY = "sandboxFactory.openedFolder";

export function activate(context: vscode.ExtensionContext): void {
  // An output channel, not a notification: it must still be there when someone
  // goes looking.
  const output = vscode.window.createOutputChannel("Lunox");
  output.appendLine(buildBanner("sandbox-factory", extensionBuild));

  /**
   * The platform origin, from user or application settings only, and the
   * token bound to it. A repository's workspace settings cannot redirect an
   * authenticated request to another host.
   */
  const resolved = resolvePlatformOrigin(
    vscode.workspace
      .getConfiguration("sandboxFactory")
      .inspect<string>("platformUrl"),
  );
  if (resolved.overrideIgnored)
    output.appendLine(
      "Ignoring a workspace-level sandboxFactory.platformUrl: the platform address is a user setting.",
    );
  if (resolved.invalid)
    output.appendLine(
      `sandboxFactory.platformUrl is not an http(s) URL; using ${resolved.origin}.`,
    );
  const origin = resolved.origin;
  const tokenKey = tokenKeyFor(origin);

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );

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
    choose: async (items, placeHolder) => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({ ...item })),
        { placeHolder, ignoreFocusOut: true },
      );
      return picked?.value;
    },
    input: (prompt, placeHolder, options) =>
      Promise.resolve(
        vscode.window.showInputBox({
          prompt,
          placeHolder,
          password: options?.password === true,
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
    openFolder: async (path, newWindow = false) => {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(path),
        { forceNewWindow: newWindow },
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
    getSecret: (key) => Promise.resolve(context.secrets.get(key)),
    storeSecret: (key, value) =>
      Promise.resolve(context.secrets.store(key, value)),
    deleteSecret: (key) => Promise.resolve(context.secrets.delete(key)),
    openExternal: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    setStatus: (view) => {
      if (view === undefined) {
        status.hide();
        return;
      }
      status.text = view.text;
      status.tooltip = view.tooltip;
      status.command = `sandboxFactory.${view.command}`;
      status.show();
    },
    progress: (title, task) =>
      Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title },
          task,
        ),
      ),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ask: (level, message, actions) =>
      Promise.resolve(
        level === "info"
          ? vscode.window.showInformationMessage(message, ...actions)
          : level === "warn"
            ? vscode.window.showWarningMessage(message, ...actions)
            : vscode.window.showErrorMessage(message, ...actions),
      ),
    info: (message) => void vscode.window.showInformationMessage(message),
    warn: (message) => void vscode.window.showWarningMessage(message),
    error: (message) => void vscode.window.showErrorMessage(message),
    log: (line) => output.appendLine(line),
    showLog: () => output.show(true),
  };
  const tasks = createTaskCommands(host);
  const contribute = createContributeCommands({
    host,
    platformUrl: origin,
    tokenKey,
    // No cookies: the token is the only credential the extension sends.
    connect: (getToken) =>
      new ContributorClient({ baseUrl: origin, getToken, credentials: "omit" }),
  });
  void tasks.announceOpened();
  void contribute.restoreStatus();

  const command = (id: string, run: () => Promise<unknown>) =>
    vscode.commands.registerCommand(`sandboxFactory.${id}`, run);
  context.subscriptions.push(
    output,
    status,
    command("openTask", () => tasks.openTask()),
    command("showTask", () => tasks.showTask()),
    command("installDependencies", () => tasks.installDependencies()),
    command("runApp", () => tasks.runApp()),
    command("runTests", () => tasks.runTests()),
    command("signIn", () => contribute.signIn()),
    command("signOut", () => contribute.signOut()),
    command("openContribution", () => contribute.openContribution()),
    command("previewSubmission", () => contribute.previewSubmission()),
    command("submit", () => contribute.submit()),
    command("gradeAgain", () => contribute.gradeAgain()),
    command("refreshStatus", () => contribute.refreshStatus()),
    command("showSubmission", () => contribute.showSubmission()),

    /**
     * Reports this build and the API's. The two can drift by days: the
     * extension updates only when the marketplace ships it and the user
     * accepts it.
     */
    command("showVersion", async () => {
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
        `Lunox extension ${formatVersion(extensionBuild)}${detail}`,
        ...(link === undefined ? [] : ["View commit"]),
      );
      if (choice === "View commit" && link !== undefined) {
        await vscode.env.openExternal(vscode.Uri.parse(link));
      }
    }),

    // A changed address needs a new client and token key, which means a reload.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sandboxFactory.platformUrl")) {
        vscode.window
          .showInformationMessage(
            "Lunox: platform URL changed. Reload to apply.",
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
 * Asks the configured platform what its API is running. Undefined on any
 * failure, like the web app's equivalent.
 *
 * Not routed through `ApiClient`: /version sits outside /api/v1 and needs no
 * credential, and that client sends one on every call.
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
