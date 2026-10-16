import { z } from "zod";

/** `GET .../settings`: a workspace's settings, defaults included. */
export const workspaceSettingsSchema = z.object({
  /**
   * Whether an approved bounty's sandbox is prepared before anyone asks for
   * it: its fixtures and name table written by agents, which is model
   * spend, so its Sandbox click waits for one baseline and the hidden tests.
   */
  prepareSandboxes: z.boolean(),
});
export type WorkspaceSettingsDto = z.infer<typeof workspaceSettingsSchema>;

/** `PATCH .../settings`: the settings to change; the rest stay. */
export const updateWorkspaceSettingsSchema = z.strictObject({
  prepareSandboxes: z.boolean().optional(),
});
export type UpdateWorkspaceSettingsInput = z.infer<
  typeof updateWorkspaceSettingsSchema
>;
