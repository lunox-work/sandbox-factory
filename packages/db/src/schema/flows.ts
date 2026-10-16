/**
 * How long people wait, read from the rows the flows already write.
 *
 * Views, not tables: nothing is stored here, and every number is derived
 * from timestamps the runs, profiles and versions keep. They read across
 * organizations, so they are for an operator at a SQL prompt. The one store
 * that reads them (`flow-waits.ts`) reads a single organization's samples,
 * for the typical durations a page shows beside its stages.
 *
 * `flow_wait_sample` is one row per wait that ended, and `flow_wait` its
 * percentiles per flow and week, so a change to the pipeline is measured
 * against the weeks before it. The flows:
 *
 * - `price`: one bounty's sizing or re-price, from the click to the
 *   proposal it writes; a board's issue run counts when it sized one
 *   bounty a person picked. A backlog run is a batch, and is left out, as
 *   is a run that wrote no proposal (one skipped for a live proposal).
 *   The write is the run's own `proposal_written_at`: a re-price rewrites
 *   the proposal in place, moving its `run_id` and keeping its
 *   `created_at`. Runs from before that was kept fall back to the spec
 *   revision the run wrote, then to the proposal it created; a re-price's
 *   proposal says nothing about the re-price, so one with neither is left
 *   out.
 * - `rubric`: from that click, for the same runs, to the last of the spec
 *   revision's profiles being ready, which is when the rubric can size it.
 * - `sandbox_sliced`, `sandbox_generated`: from a sandbox version's draft
 *   to its build succeeding.
 * - `queue:<tool>`: an analysis run's wait for a worker to claim it.
 * - `run:<tool>`: an analysis run from being claimed to succeeding.
 *
 * Weeks begin on a Monday in UTC, whatever the session's time zone.
 */

import { sql } from "drizzle-orm";
import {
  doublePrecision,
  integer,
  pgView,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * The waits, one row each. Shared by both views rather than one reading
 * the other, so neither depends on the order their migration creates them.
 */
const SAMPLES = sql`
  select 'price' as flow, r.organization_id, r.created_at as started_at,
    extract(epoch from w.written_at - r.created_at)::double precision as seconds
  from bounty_run r
  cross join lateral (
    select coalesce(
      r.proposal_written_at,
      (select min(s.created_at) from bounty_spec s where s.run_id = r.id),
      (select min(p.created_at) from bounty_proposal p
        where p.run_id = r.id and r.kind <> 'reprice')
    ) as written_at
  ) w
  where w.written_at is not null
    and (r.kind in ('bounty', 'reprice')
      or (r.kind = 'issue' and jsonb_array_length(r.planned) = 1))
    and r.status in ('succeeded', 'partial')
  union all
  select 'rubric', r.organization_id, r.created_at,
    extract(epoch from max(p.updated_at) - r.created_at)::double precision
  from bounty_profile p
  join bounty_spec s on s.proposal_id = p.proposal_id and s.revision = p.spec_revision
  join bounty_run r on r.id = s.run_id
  where r.kind in ('bounty', 'reprice')
    or (r.kind = 'issue' and jsonb_array_length(r.planned) = 1)
  group by r.id, r.organization_id, r.created_at, p.proposal_id, p.spec_revision
  having bool_and(p.status = 'ready')
  union all
  select case when vs.slice_run_id is null then 'sandbox_generated' else 'sandbox_sliced' end,
    b.organization_id, v.created_at,
    extract(epoch from b.finished_at - v.created_at)::double precision
  from sandbox_version v
  join sandbox_version_source vs on vs.sandbox_version_id = v.id
  join analysis_run b on b.id = vs.build_run_id
  where b.status = 'succeeded' and b.finished_at is not null
  union all
  select 'queue:' || a.tool, a.organization_id, a.created_at,
    extract(epoch from a.started_at - a.created_at)::double precision
  from analysis_run a
  where a.started_at is not null
  union all
  select 'run:' || a.tool, a.organization_id, a.created_at,
    extract(epoch from a.finished_at - a.started_at)::double precision
  from analysis_run a
  where a.status = 'succeeded' and a.finished_at is not null
    and a.started_at is not null
`;

export const flowWaitSample = pgView("flow_wait_sample", {
  flow: text("flow").notNull(),
  organizationId: text("organization_id").notNull(),
  /** When the wait began: the click, or the run's being asked for. */
  startedAt: ts("started_at").notNull(),
  seconds: doublePrecision("seconds").notNull(),
}).as(SAMPLES);

export const flowWait = pgView("flow_wait", {
  flow: text("flow").notNull(),
  /** The Monday the week's waits began in. */
  week: ts("week").notNull(),
  samples: integer("samples").notNull(),
  p50: doublePrecision("p50").notNull(),
  p90: doublePrecision("p90").notNull(),
  p95: doublePrecision("p95").notNull(),
  max: doublePrecision("max").notNull(),
}).as(sql`
  select flow, date_trunc('week', started_at, 'UTC') as week, count(*)::int as samples,
    percentile_cont(0.5) within group (order by seconds) as p50,
    percentile_cont(0.9) within group (order by seconds) as p90,
    percentile_cont(0.95) within group (order by seconds) as p95,
    max(seconds) as max
  from (${SAMPLES}) sample
  group by flow, date_trunc('week', started_at, 'UTC')
`);
