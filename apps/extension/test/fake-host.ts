import type { Choice, Host, Level, StatusView } from "../src/host.js";

export interface FakeHostOptions {
  folders?: string[];
  trusted?: boolean;
  files?: Record<string, string>;
  /**
   * Answers to quick picks, in order: a label to choose by, or undefined
   * to dismiss.
   */
  choices?: (string | undefined)[];
  inputs?: (string | undefined)[];
  folderPicks?: (string | undefined)[];
  /** Answers to messages with buttons, in order. */
  answers?: (string | undefined)[];
  secrets?: Record<string, string>;
  remembered?: string;
  /** Runs at each wait, as another command would meanwhile. */
  onDelay?: () => unknown;
}

/** A `Host` that records what the commands did and answers from scripts. */
export function fakeHost(options: FakeHostOptions = {}) {
  const log: string[] = [];
  const messages: {
    level: Level;
    text: string;
    actions?: readonly string[];
  }[] = [];
  const terminals: { name: string; cwd: string; command: string }[] = [];
  const opened: { path: string; newWindow: boolean }[] = [];
  const external: string[] = [];
  const statuses: (StatusView | undefined)[] = [];
  const offered: { placeholder: string; labels: string[] }[] = [];
  const delays: number[] = [];
  const choices = [...(options.choices ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const folderPicks = [...(options.folderPicks ?? [])];
  const answers = [...(options.answers ?? [])];
  const files = options.files ?? {};
  const secrets: Record<string, string> = { ...(options.secrets ?? {}) };
  const state: {
    remembered: string | undefined;
    logShown: number;
    passwordPrompts: number;
  } = { remembered: options.remembered, logShown: 0, passwordPrompts: 0 };
  const host: Host = {
    workspaceFolders: () => options.folders ?? [],
    isTrusted: () => options.trusted ?? true,
    readFile: async (path) => files[path] ?? null,
    choose: async <T>(items: readonly Choice<T>[], placeholder: string) => {
      offered.push({ placeholder, labels: items.map((item) => item.label) });
      const label = choices.shift();
      if (label === undefined) return undefined;
      const item = items.find((each) => each.label.startsWith(label));
      if (item === undefined)
        throw new Error(
          `No choice "${label}" among ${items.map((each) => each.label).join(" | ")}`,
        );
      return item.value;
    },
    input: async (_prompt, _placeholder, inputOptions) => {
      if (inputOptions?.password === true) state.passwordPrompts += 1;
      return inputs.shift();
    },
    pickFolder: async () => folderPicks.shift(),
    openFolder: async (path, newWindow = false) => {
      opened.push({ path, newWindow });
    },
    rememberOpened: async (folder) => {
      state.remembered = folder;
    },
    openedFolder: () => state.remembered,
    runInTerminal: (name, cwd, command) =>
      terminals.push({ name, cwd, command }),
    getSecret: async (key) => secrets[key],
    storeSecret: async (key, value) => {
      secrets[key] = value;
    },
    deleteSecret: async (key) => {
      delete secrets[key];
    },
    openExternal: async (url) => {
      external.push(url);
    },
    setStatus: (view) => statuses.push(view),
    progress: (_title, task) => task(),
    delay: async (ms) => {
      delays.push(ms);
      await options.onDelay?.();
    },
    ask: async (level, text, actions) => {
      messages.push({ level, text, actions });
      return answers.shift();
    },
    info: (text) => messages.push({ level: "info", text }),
    warn: (text) => messages.push({ level: "warn", text }),
    error: (text) => messages.push({ level: "error", text }),
    log: (line) => log.push(line),
    showLog: () => {
      state.logShown += 1;
    },
  };
  return {
    host,
    log,
    messages,
    terminals,
    opened,
    external,
    statuses,
    offered,
    delays,
    secrets,
    state,
  };
}
