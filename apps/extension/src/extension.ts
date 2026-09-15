/**
 * VS Code extension entry point.
 *
 * This is the only workspace that may import `vscode`. Everything it knows
 * about the API comes from @sandbox-factory/client — the same client the web
 * dashboard uses — so an endpoint change lands in both surfaces at once.
 */

import { ApiError, TodoClient } from "@sandbox-factory/client";
import { isValidTitle } from "sandbox-factory";
import * as vscode from "vscode";

import { TodoTreeProvider, type TodoNode } from "./tree";

/**
 * Where the bearer token lives. `context.secrets` is encrypted by VS Code;
 * a setting would put the token in plaintext settings.json, which is why the
 * configuration only exposes the base URL.
 */
const TOKEN_KEY = "sandboxFactory.token";

export function activate(context: vscode.ExtensionContext): void {
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
        // Reuses the core rule rather than restating it, so this matches what
        // the API would accept.
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
        // Modal: deleting is not undoable here, and a tree row is easy to
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
      // Someone else deleted it; refreshing is the whole fix.
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
