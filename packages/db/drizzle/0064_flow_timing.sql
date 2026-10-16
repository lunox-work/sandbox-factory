ALTER TABLE "analysis_run" ADD COLUMN "timing" jsonb;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD COLUMN "transitions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD COLUMN "model_calls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE VIEW "public"."flow_wait" AS (
  select flow, date_trunc('week', started_at) as week, count(*)::int as samples,
    percentile_cont(0.5) within group (order by seconds) as p50,
    percentile_cont(0.9) within group (order by seconds) as p90,
    percentile_cont(0.95) within group (order by seconds) as p95,
    max(seconds) as max
  from (
  select 'price' as flow, r.organization_id, r.created_at as started_at,
    extract(epoch from r.finished_at - r.created_at)::double precision as seconds
  from bounty_run r
  where (r.kind in ('bounty', 'reprice')
      or (r.kind = 'issue' and jsonb_array_length(r.planned) = 1))
    and r.status in ('succeeded', 'partial')
    and r.finished_at is not null
  union all
  select 'rubric', r.organization_id, r.created_at,
    extract(epoch from max(p.updated_at) - r.created_at)::double precision
  from bounty_profile p
  join bounty_spec s on s.proposal_id = p.proposal_id and s.revision = p.spec_revision
  join bounty_run r on r.id = s.run_id
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
    extract(epoch from a.finished_at - a.created_at)::double precision
  from analysis_run a
  where a.status = 'succeeded' and a.finished_at is not null
) sample
  group by flow, date_trunc('week', started_at)
);--> statement-breakpoint
CREATE VIEW "public"."flow_wait_sample" AS (
  select 'price' as flow, r.organization_id, r.created_at as started_at,
    extract(epoch from r.finished_at - r.created_at)::double precision as seconds
  from bounty_run r
  where (r.kind in ('bounty', 'reprice')
      or (r.kind = 'issue' and jsonb_array_length(r.planned) = 1))
    and r.status in ('succeeded', 'partial')
    and r.finished_at is not null
  union all
  select 'rubric', r.organization_id, r.created_at,
    extract(epoch from max(p.updated_at) - r.created_at)::double precision
  from bounty_profile p
  join bounty_spec s on s.proposal_id = p.proposal_id and s.revision = p.spec_revision
  join bounty_run r on r.id = s.run_id
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
    extract(epoch from a.finished_at - a.created_at)::double precision
  from analysis_run a
  where a.status = 'succeeded' and a.finished_at is not null
);