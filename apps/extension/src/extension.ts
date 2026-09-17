/**
 * VS Code extension entry point. The only workspace that may import `vscode`.
 * It reaches the API through @sandbox-factory/client, the same client the web
 * app uses, so an endpoint change lands in both at once.
 */

import { ApiError, TodoClient } from "@sandbox-factory/client";
import {
  buildBanner,
  buildInfoSchema,
  commitUrl,
  formatVersion,
  sameBuild,
  type BuildInfoDto,
} from "@sandbox-factory/shared";
import { isValidTitle } from "sandbox-factory";
import * as vscode from "vscode";

import { extensionBuild } from "./build";
import { TodoTreeProvider, type TodoNode } from "./tree";

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

  const client = new TodoClient({
    baseUrl: baseUrl(),
    getToken: () =>
      context.secrets.get(TOKEN_KEY).then((token) => token ?? null),
  });

  const tree = new TodoTreeProvider(client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sandboxFactory.todos", tree),

    vscode.commands.registerCommand("sandboxFactory.refresh", () =>
      tree.refresh(),
    ),

    vscode.commands.registerCommand("sandboxFactory.create", async () => {
      const title = await vscode.window.showInputBox({
        prompt: "What needs doing?",
        // The core rule, so this matches what the API accepts.
        validateInput: (value) =>
          isValidTitle(value)
            ? undefined
            : "A todo needs a title of 200 characters or fewer.",
      });
      if (title === undefined) {
        return;
      }
      await run(tree, () => client.createTodo({ title }));
    }),

    vscode.commands.registerCommand(
      "sandboxFactory.toggle",
      async (node?: TodoNode) => {
        if (node === undefined) {
          return;
        }
        await run(tree, () => client.setDone(node.todo.id, !node.todo.done));
      },
    ),

    vscode.commands.registerCommand(
      "sandboxFactory.rename",
      async (node?: TodoNode) => {
        if (node === undefined) {
          return;
        }
        const title = await vscode.window.showInputBox({
          prompt: "Rename todo",
          value: node.todo.title,
          validateInput: (value) =>
            isValidTitle(value)
              ? undefined
              : "A todo needs a title of 200 characters or fewer.",
        });
        if (title === undefined || title === node.todo.title) {
          return;
        }
        await run(tree, () => client.updateTodo(node.todo.id, { title }));
      },
    ),

    vscode.commands.registerCommand(
      "sandboxFactory.delete",
      async (node?: TodoNode) => {
        if (node === undefined) {
          return;
        }
        // Modal: deleting is not undoable, and a tree row is easy to
        // right-click by accident.
        const confirmed = await vscode.window.showWarningMessage(
          `Delete "${node.todo.title}"?`,
          { modal: true },
          "Delete",
        );
        if (confirmed !== "Delete") {
          return;
        }
        await run(tree, () => client.deleteTodo(node.todo.id));
      },
    ),

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
 * Not routed through `TodoClient`: /version sits outside /api/v1 and needs no
 * session, and every other call on that client is authenticated.
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

/** Runs an API call, refreshing on success and reporting failure readably. */
async function run(
  tree: TodoTreeProvider,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
    tree.refresh();
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) {
      // Already deleted elsewhere; refreshing is the whole fix.
      tree.refresh();
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
