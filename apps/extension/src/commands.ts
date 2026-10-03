/**
 * The local task workflow: open a task, read what it is, install, run and
 * test it in the editor's own terminals.
 *
 * Opening a repository executes nothing. Every script runs only when the
 * user invokes the command, in a trusted workspace, and is always the fixed
 * command line a terminal user would type; the descriptor is read for
 * display and never for what to execute. No hosted session, token or
 * account is involved: this is the same local flow as a terminal.
 */

import { join } from "node:path";
import type { SandboxCommand } from "sandbox-factory";
import { TASK_DESCRIPTOR_PATH } from "sandbox-factory";
import type { TaskDescriptorDto } from "@sandbox-factory/shared";
import type { Host } from "./host.js";
import {
  cloneTarget,
  commandLine,
  describeTask,
  parseDescriptor,
} from "./task.js";

export interface LocatedTask {
  readonly folder: string;
  readonly descriptor: TaskDescriptorDto;
}

export interface TaskCommands {
  openTask(): Promise<void>;
  showTask(): Promise<void>;
  installDependencies(): Promise<void>;
  runApp(): Promise<void>;
  runTests(): Promise<void>;
  /** On activation: describe a task this extension just opened, once. */
  announceOpened(): Promise<void>;
}

export const OPEN_CLONE = "Clone a task repository";
export const OPEN_LOCAL = "Open a local clone";

export function createTaskCommands(host: Host): TaskCommands {
  /** The first workspace folder holding a valid descriptor, or why none does. */
  async function locate(): Promise<LocatedTask | null> {
    const folders = host.workspaceFolders();
    if (folders.length === 0) {
      host.error("sandbox-factory: open a task folder first.");
      return null;
    }
    let lastDetail = "";
    for (const folder of folders) {
      const result = parseDescriptor(
        await host.readFile(join(folder, TASK_DESCRIPTOR_PATH)),
      );
      if (result.ok) return { folder, descriptor: result.descriptor };
      lastDetail = result.detail;
    }
    host.error(`sandbox-factory: ${lastDetail}`);
    return null;
  }
  async function runScript(kind: SandboxCommand, name: string): Promise<void> {
    if (!host.isTrusted()) {
      host.error(
        "sandbox-factory: this workspace is not trusted, so its scripts are not run. Trust the folder to continue.",
      );
      return;
    }
    const task = await locate();
    if (task === null) return;
    const line = commandLine(kind);
    host.log(`${name}: ${line} in ${task.folder}`);
    host.runInTerminal(`sandbox-factory: ${name}`, task.folder, line);
  }
  async function reportDescriptor(folder: string): Promise<void> {
    const result = parseDescriptor(
      await host.readFile(join(folder, TASK_DESCRIPTOR_PATH)),
    );
    if (result.ok)
      host.info(`sandbox-factory: ${describeTask(result.descriptor)}`);
    else host.warn(`sandbox-factory: ${result.detail}`);
  }
  /**
   * Opening another folder reloads the window, so the task is described
   * when it starts again; an already open folder is described now.
   */
  async function open(folder: string): Promise<void> {
    if (host.workspaceFolders().includes(folder)) {
      await reportDescriptor(folder);
      return;
    }
    await host.rememberOpened(folder);
    await host.openFolder(folder);
  }
  return {
    async openTask() {
      const choice = await host.pick(
        [OPEN_CLONE, OPEN_LOCAL],
        "How do you want to open the task?",
      );
      if (choice === undefined) return;
      if (choice === OPEN_LOCAL) {
        const folder = await host.pickFolder("Open the task clone");
        if (folder === undefined) return;
        await open(folder);
        return;
      }
      const raw = await host.input(
        "Task repository URL",
        "https://github.com/owner/task",
      );
      if (raw === undefined) return;
      const target = cloneTarget(raw);
      if (!target.ok) {
        host.error(`sandbox-factory: ${target.detail}`);
        return;
      }
      const parent = await host.pickFolder("Clone into");
      if (parent === undefined) return;
      const destination = join(parent, target.folder);
      host.log(`clone: ${target.url} → ${destination}`);
      try {
        await host.clone(target.url, destination);
      } catch (error) {
        host.error(
          `sandbox-factory: clone failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      // Opening installs nothing and runs nothing; the next commands do.
      await open(destination);
    },
    async announceOpened() {
      const folder = host.openedFolder();
      if (folder === undefined) return;
      await host.rememberOpened(undefined);
      if (host.workspaceFolders().includes(folder))
        await reportDescriptor(folder);
    },
    async showTask() {
      const task = await locate();
      if (task === null) return;
      host.log(
        `Task ${task.descriptor.versionId}: ${describeTask(task.descriptor)}`,
      );
      host.log(`Spec: ${task.descriptor.specSummary}`);
      for (const path of task.descriptor.editablePaths)
        host.log(`  editable: ${path}`);
      for (const path of task.descriptor.publicTests)
        host.log(`  test: ${path}`);
      host.info(`sandbox-factory: ${describeTask(task.descriptor)}`);
    },
    installDependencies: () => runScript("install", "install"),
    runApp: () => runScript("dev", "run"),
    runTests: () => runScript("test", "test"),
  };
}
