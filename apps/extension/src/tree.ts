/** The Todos tree view. */

import type { TodoClient } from "@sandbox-factory/client";
import type { TodoDto } from "@sandbox-factory/shared";
import * as vscode from "vscode";

export class TodoNode extends vscode.TreeItem {
  constructor(readonly todo: TodoDto) {
    super(todo.title, vscode.TreeItemCollapsibleState.None);
    // Lets package.json show "Mark done" or "Mark not done" per row.
    this.contextValue = todo.done ? "todo.done" : "todo.active";
    this.tooltip = `${todo.title}\n${todo.done ? "Done" : "Active"}\nCreated: ${todo.createdAt}`;
    this.iconPath = new vscode.ThemeIcon(
      todo.done ? "pass-filled" : "circle-large-outline",
    );
    if (todo.done) {
      // A TreeItem label cannot be struck through, so the description carries
      // the signal.
      this.description = "done";
    }
  }
}

/** A placeholder row that surfaces load failures inside the tree. */
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
      // Rendered rather than thrown: a rejection here leaves the view stuck on
      // its loading message.
      return [
        new MessageNode(
          error instanceof Error ? error.message : "Failed to load.",
        ),
      ];
    }
  }
}
