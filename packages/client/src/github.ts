import {
  githubConnectionListSchema,
  githubAvailableInstallationsSchema,
  githubInstallationRepositoriesSchema,
  githubConnectionResponseSchema,
  githubRepoResponseSchema,
  githubRepoListSchema,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
import { ownerPath } from "./bounties.js";
export class GithubManagementClient extends ApiClient {
  async available(owner: string, signal?: AbortSignal) {
    return githubAvailableInstallationsSchema.parse(
      await this.request(`${ownerPath(owner)}/github/connections/available`, {
        signal,
      }),
    );
  }
  async installationRepositories(
    owner: string,
    id: string,
    signal?: AbortSignal,
  ) {
    return githubInstallationRepositoriesSchema.parse(
      await this.request(
        `${ownerPath(owner)}/github/connections/${encodeURIComponent(id)}/repositories`,
        { signal },
      ),
    ).repositories;
  }
  async link(owner: string, installationId: string) {
    return githubConnectionResponseSchema.parse(
      await this.request(`${ownerPath(owner)}/github/connections`, {
        method: "POST",
        body: JSON.stringify({ installationId }),
      }),
    ).connection;
  }
  async register(owner: string, id: string, externalId: string) {
    return githubRepoResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/github/connections/${encodeURIComponent(id)}/repositories`,
        {
          method: "POST",
          body: JSON.stringify({ externalId, role: "source" }),
        },
      ),
    ).repository;
  }
  async remove(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/github/repositories/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
  async connections(owner: string, signal?: AbortSignal) {
    return githubConnectionListSchema.parse(
      await this.request(`${ownerPath(owner)}/github/connections`, { signal }),
    ).connections;
  }
  async repositories(owner: string, signal?: AbortSignal) {
    return githubRepoListSchema.parse(
      await this.request(`${ownerPath(owner)}/github/repositories`, { signal }),
    ).repositories;
  }
  async disconnect(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/github/connections/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
