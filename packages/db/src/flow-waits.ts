/**
 * How long a workspace's waits usually take, read from `flow_wait_sample`,
 * so a page can say beside a stage's clock what to expect of it. The
 * workspace's own waits only: another's are not its business.
 */

import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { Database } from "./errors.js";
import { flowWaitSample } from "./schema.js";

export interface FlowTypical {
  /** The median wait, in seconds. */
  readonly p50: number;
  readonly samples: number;
}

export interface FlowWaitStore {
  /** Each of `flows` with any wait since `since`; one with none is absent. */
  typical(
    organizationId: string,
    flows: readonly string[],
    since: Date,
  ): Promise<ReadonlyMap<string, FlowTypical>>;
}

export function createFlowWaitStore(db: Database): FlowWaitStore {
  return {
    async typical(organizationId, flows, since) {
      if (flows.length === 0) return new Map();
      const rows = await db
        .select({
          flow: flowWaitSample.flow,
          p50: sql<number>`percentile_cont(0.5) within group (order by ${flowWaitSample.seconds})`,
          samples: sql<number>`count(*)::int`,
        })
        .from(flowWaitSample)
        .where(
          and(
            eq(flowWaitSample.organizationId, organizationId),
            inArray(flowWaitSample.flow, [...flows]),
            gte(flowWaitSample.startedAt, since),
          ),
        )
        .groupBy(flowWaitSample.flow);
      return new Map(
        rows.map(({ flow, p50, samples }) => [
          flow,
          { p50: Number(p50), samples: Number(samples) },
        ]),
      );
    },
  };
}
