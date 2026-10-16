import { eq } from "drizzle-orm";

import type { Database } from "./errors.js";
import { workspaceSetting } from "./schema.js";

/** A workspace's settings; an organization that has changed none has these. */
export interface WorkspaceSettings {
  /**
   * Whether an approved bounty's sandbox is prepared before anyone asks
   * for it: its fixtures and name table written by agents once its price
   * is approved, so the Sandbox click waits for one baseline and the
   * hidden tests only.
   */
  readonly prepareSandboxes: boolean;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  prepareSandboxes: true,
};

export interface WorkspaceSettingsStore {
  get(organizationId: string): Promise<WorkspaceSettings>;
  /** Writes the settings given, keeping the rest. */
  update(
    organizationId: string,
    change: Partial<WorkspaceSettings>,
    updatedBy: string,
  ): Promise<WorkspaceSettings>;
}

export function createWorkspaceSettingsStore(
  db: Database,
): WorkspaceSettingsStore {
  const read = async (owner: string): Promise<WorkspaceSettings> => {
    const row = (
      await db
        .select({ prepareSandboxes: workspaceSetting.prepareSandboxes })
        .from(workspaceSetting)
        .where(eq(workspaceSetting.organizationId, owner))
        .limit(1)
    )[0];
    return row ?? DEFAULT_WORKSPACE_SETTINGS;
  };
  return {
    get: read,
    async update(owner, change, updatedBy) {
      const next = { ...(await read(owner)), ...change };
      await db
        .insert(workspaceSetting)
        .values({ organizationId: owner, ...next, updatedBy })
        .onConflictDoUpdate({
          target: workspaceSetting.organizationId,
          set: { ...next, updatedBy, updatedAt: new Date() },
        });
      return next;
    },
  };
}
