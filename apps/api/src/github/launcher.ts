import { randomUUID } from "node:crypto";
import type { AnalysisRunStore } from "@sandbox-factory/db";
import type {
  RunTaskCommandInput,
  RunTaskCommandOutput,
} from "@aws-sdk/client-ecs";

export interface WorkerLaunchConfig {
  readonly taskDefinition: string;
  readonly cluster: string;
  readonly subnets: readonly string[];
  readonly securityGroup: string;
}
export class WorkerLauncher {
  #pending: Promise<void> | undefined;
  #lastLaunch = 0;
  constructor(
    readonly options: {
      runs: Pick<AnalysisRunStore, "queueState">;
      config?: WorkerLaunchConfig | undefined;
      launch?: (input: RunTaskCommandInput) => Promise<RunTaskCommandOutput>;
      now?: () => Date;
    },
  ) {}
  async ensureWorker(): Promise<void> {
    if (this.#pending !== undefined) return this.#pending;
    const pending = this.#ensure();
    this.#pending = pending;
    try {
      await pending;
    } finally {
      this.#pending = undefined;
    }
  }
  async #ensure(): Promise<void> {
    const config = this.options.config;
    if (config === undefined) return; // Compose's polling worker needs no ECS.
    const now = (this.options.now ?? (() => new Date()))();
    const state = await this.options.runs.queueState(now);
    if (
      !state.queued ||
      state.freshWorker ||
      now.getTime() - this.#lastLaunch < 30_000
    )
      return;
    const input: RunTaskCommandInput = {
      cluster: config.cluster,
      taskDefinition: config.taskDefinition,
      count: 1,
      launchType: "FARGATE",
      clientToken: randomUUID(),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [...config.subnets],
          securityGroups: [config.securityGroup],
          assignPublicIp: "ENABLED",
        },
      },
    };
    // Stamped before the attempt, not after a success: the thirty seconds
    // are a backoff as much as a debounce. A failing RunTask (no capacity,
    // a bad task definition, throttling) would otherwise be retried on
    // every `ensureWorker()`, each one another ECS call that fails the same.
    this.#lastLaunch = now.getTime();
    let output;
    if (this.options.launch !== undefined)
      output = await this.options.launch(input);
    else {
      const { ECSClient, RunTaskCommand } = await import("@aws-sdk/client-ecs");
      output = await new ECSClient({}).send(new RunTaskCommand(input));
    }
    if (output.failures?.length || !output.tasks?.length)
      throw new Error("The analysis worker could not be launched.");
  }
}
