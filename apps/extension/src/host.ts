/**
 * The editor as the commands see it. Implemented over the `vscode` API in
 * `extension.ts` and by a fake in the tests, so command logic is tested
 * without an extension host.
 */
export interface Host {
  workspaceFolders(): readonly string[];
  /** Workspace Trust. Untrusted folders never have their scripts run. */
  isTrusted(): boolean;
  readFile(path: string): Promise<string | null>;
  pick(
    items: readonly string[],
    placeholder: string,
  ): Promise<string | undefined>;
  input(prompt: string, placeholder?: string): Promise<string | undefined>;
  pickFolder(title: string): Promise<string | undefined>;
  clone(url: string, destination: string): Promise<void>;
  /** Opens the folder in this window, which reloads it. */
  openFolder(path: string): Promise<void>;
  /**
   * A folder whose task is described once the window it opens in starts:
   * opening reloads the window, which drops any message shown before.
   * Kept in the extension's global state; `undefined` clears it.
   */
  rememberOpened(folder: string | undefined): Promise<void>;
  openedFolder(): string | undefined;
  /** A visible terminal in `cwd` that runs `command`, exactly as typed. */
  runInTerminal(name: string, cwd: string, command: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  log(line: string): void;
}
