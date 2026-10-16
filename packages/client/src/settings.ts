import {
  workspaceSettingsSchema,
  type UpdateWorkspaceSettingsInput,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";

/** A workspace's own settings: any member reads them, admins change them. */
export class WorkspaceSettingsClient extends ApiClient {
  #path(owner: string) {
    return `/api/v1/orgs/${encodeURIComponent(owner)}/settings`;
  }
  async settings(owner: string, signal?: AbortSignal) {
    return workspaceSettingsSchema.parse(
      await this.request(this.#path(owner), { signal }),
    );
  }
  async saveSettings(owner: string, input: UpdateWorkspaceSettingsInput) {
    return workspaceSettingsSchema.parse(
      await this.request(this.#path(owner), {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    );
  }
}
