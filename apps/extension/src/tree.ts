/**
 * The Todos tree view.
 */

import type { TodoClient } from "@sandbox-factory/client";
import type { TodoDto } from "@sandbox-factory/shared";
import * as vscode from "vscode";

export class TodoNode extends vscode.TreeItem {
  constructor(readonly todo: TodoDto) {
    super(todo.title, vscode.TreeItemCollapsibleState.None);
    // Distinct context values let package.json show "Mark done" and "Mark not
    // done" on the right rows without either command checking state itself.
    this.contextValue = todo.done ? "todo.done" : "todo.active";
    this.tooltip = `${todo.title}\n${todo.done ? "Done" : "Active"}\nCreated: ${todo.createdAt}`;
    this.iconPath = new vscode.ThemeIcon(
      todo.done ? "pass-filled" : "circle-large-outline",
    );
    if (todo.done) {
      // strikethrough is not available on a TreeItem label, so the dimmed
      // description carries the completed signal instead.
      this.description = "done";
    }
  }
}

/** A placeholder row used to surface load failures inside the tree itself. */
class MessageNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("warning");
  }
}

export class TodoTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;

  constructor(private readonly client: TodoClient) {}

  refresh(): void {
    this.#changed.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Flat list: only the root has children.
    if (element !== undefined) {
      return [];
    }
    try {
      const todos = await this.client.listTodos();
      return todos.map((todo) => new TodoNode(todo));
    } catch (error) {
      // Rendered in the tree rather than thrown: an unhandled rejection here
      // leaves the view stuck on its loading message with no explanation.
      return [
        new MessageNode(
          error instanceof Error ? error.message : "Failed to load.",
        ),
      ];
    }
  }
}
