import type { UpdateBoardInput } from "@sandbox-factory/shared";
import {
  jiraConnectionListSchema,
  jiraBoardResponseDtoSchema,
  jiraSyncResponseSchema,
  jiraIssueDetailResponseSchema,
  jiraBacklogPreviewSchema,
  jiraIssueSearchSchema,
  jiraWorkspaceIssueSearchSchema,
  proposalActionResponseSchema,
  jiraBoardListSchema,
} from "@sandbox-factory/shared";
import { ApiClient } from "./transport.js";
import { ownerPath } from "./bounties.js";
export class JiraManagementClient extends ApiClient {
  async sync(owner: string, id: string) {
    return jiraSyncResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/connections/${encodeURIComponent(id)}/sync`,
        { method: "POST" },
      ),
    ).added;
  }
  async issue(
    owner: string,
    boardId: string,
    key: string,
    signal?: AbortSignal,
  ) {
    return jiraIssueDetailResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/issues/${encodeURIComponent(key)}`,
        { signal },
      ),
    ).issue;
  }
  async preview(owner: string, boardId: string, signal?: AbortSignal) {
    return jiraBacklogPreviewSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/backlog-preview`,
        { signal },
      ),
    );
  }
  async updateBoard(owner: string, id: string, input: UpdateBoardInput) {
    return jiraBoardResponseDtoSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    ).board;
  }
  async search(
    owner: string,
    boardId: string,
    query: string,
    signal?: AbortSignal,
  ) {
    return jiraIssueSearchSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/search?q=${encodeURIComponent(query)}`,
        { signal },
      ),
    ).issues;
  }
  /** The workspace's issues matching `query`, from every board it has. */
  async searchAll(owner: string, query: string, signal?: AbortSignal) {
    return jiraWorkspaceIssueSearchSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/search?q=${encodeURIComponent(query)}`,
        { signal },
      ),
    ).issues;
  }
  async proposeIssue(
    owner: string,
    boardId: string,
    issueId: string,
    requestId: string,
  ) {
    return proposalActionResponseSchema.parse(
      await this.request(
        `${ownerPath(owner)}/jira/boards/${encodeURIComponent(boardId)}/issues`,
        { method: "POST", body: JSON.stringify({ requestId, issueId }) },
      ),
    );
  }
  async connections(owner: string, signal?: AbortSignal) {
    return jiraConnectionListSchema.parse(
      await this.request(`${ownerPath(owner)}/jira/connections`, { signal }),
    ).connections;
  }
  async boards(owner: string, signal?: AbortSignal) {
    return jiraBoardListSchema.parse(
      await this.request(`${ownerPath(owner)}/jira/boards`, { signal }),
    ).boards;
  }
  async disconnect(owner: string, id: string) {
    await this.request(
      `${ownerPath(owner)}/jira/connections/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
