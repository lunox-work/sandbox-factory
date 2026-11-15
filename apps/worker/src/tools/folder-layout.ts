/**
 * carveout's layout of a folder (`folderLayout`, `carveout/api`) as core's
 * `GradingLayout` reads it: an uploaded hand-off folder's
 * (`sandbox-import.ts`) and a project the carveout engine generated
 * (`project-generator.ts`). Its own module so both import it without a
 * cycle through `sandbox-build.ts`.
 */

import type { FolderLayout } from "carveout/api";
import { TASK_DESCRIPTOR_PATH } from "sandbox-factory";
import type { GradingLayout } from "sandbox-factory";

/**
 * carveout's layout of a folder as grading reads it: the same, with the
 * descriptor the platform adds among the files a submission never changes.
 */
export function gradingLayoutOf(folder: FolderLayout): GradingLayout {
  return {
    harnessDir: folder.harnessDir,
    mocksDir: folder.mocksDir,
    mockRuntimePath: folder.mockRuntimePath,
    envFile: folder.envFile,
    harnessRoots: [...folder.harnessRoots],
    configFiles: {
      ...folder.configFiles,
      [TASK_DESCRIPTOR_PATH]: `${TASK_DESCRIPTOR_PATH} is the version's.`,
    },
    commands: folder.commands.map(({ name, argv }) => ({
      name,
      argv: [...argv],
    })),
    tests: {
      publicDir: folder.tests.publicDir,
      privateDir: folder.tests.privateDir,
      files: [...folder.tests.files],
      run: {
        "node:test": {
          argv: [...folder.tests.run["node:test"].argv],
          emitted: folder.tests.run["node:test"].emitted,
        },
        vitest:
          folder.tests.run.vitest === null
            ? null
            : {
                argv: [...folder.tests.run.vitest.argv],
                emitted: folder.tests.run.vitest.emitted,
              },
      },
    },
  };
}
