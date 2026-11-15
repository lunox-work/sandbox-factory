/**
 * The editor as the commands see it. Implemented over the `vscode` API in
 * `extension.ts` and by a fake in the tests, so command logic is tested
 * without an extension host.
 */

/** One quick-pick row and the value choosing it answers. */
export interface Choice<T> {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly value: T;
}

/** The status bar item: what it says and what clicking it runs. */
export interface StatusView {
  readonly text: string;
  readonly tooltip: string;
  readonly command: "gradeAgain" | "showSubmission" | "refreshStatus";
}

export type Level = "info" | "warn" | "error";

export interface Host {
  workspaceFolders(): readonly string[];
  /** Workspace Trust. Untrusted folders never have their scripts run. */
  isTrusted(): boolean;
  readFile(path: string): Promise<string | null>;
  choose<T>(
    items: readonly Choice<T>[],
    placeholder: string,
  ): Promise<T | undefined>;
  input(
    prompt: string,
    placeholder?: string,
    options?: { readonly password?: boolean },
  ): Promise<string | undefined>;
  pickFolder(title: string): Promise<string | undefined>;
  /** Opens the folder, in this window (which reloads it) or a new one. */
  openFolder(path: string, newWindow?: boolean): Promise<void>;
  /**
   * A folder whose task is described once the window it opens in starts:
   * opening reloads the window, which drops any message shown before.
   * Kept in the extension's global state; `undefined` clears it.
   */
  rememberOpened(folder: string | undefined): Promise<void>;
  openedFolder(): string | undefined;
  /** A visible terminal in `cwd` that runs `command`, exactly as typed. */
  runInTerminal(name: string, cwd: string, command: string): void;
  /** VS Code `SecretStorage`: the OS keychain, never settings. */
  getSecret(key: string): Promise<string | undefined>;
  storeSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** The status bar item; `undefined` hides it. */
  setStatus(view: StatusView | undefined): void;
  /** Runs `task` under a progress notification titled `title`. */
  progress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** Waits; the tests' is immediate. */
  delay(ms: number): Promise<void>;
  /** A message with buttons: the one pressed, or undefined when dismissed. */
  ask(
    level: Level,
    message: string,
    actions: readonly string[],
  ): Promise<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  log(line: string): void;
  /** Brings the output channel the log writes to into view. */
  showLog(): void;
}
