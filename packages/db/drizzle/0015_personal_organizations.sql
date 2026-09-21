ALTER TABLE "todos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "todos" CASCADE;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "kind" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "personal_user_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_personal_user_id_user_id_fk" FOREIGN KEY ("personal_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_personal_user_id_unique" UNIQUE("personal_user_id");--> statement-breakpoint
-- Backfill: one personal organization per existing user.
--
-- Hand-written because drizzle-kit generates schema, not data, and because
-- after this migration the invariant "every user has a personal organization"
-- is what `organization.personal_user_id` being unique is worth. New users get
-- theirs from the signup hook in `apps/api/src/auth.ts`; this covers everyone
-- who signed up before it existed.
--
-- The handle is the user's own, which is the rule the hook follows too. A team
-- organization may already hold it — the two share one namespace — so a taken
-- handle gets `-2`, `-3` and so on. The id is `org_` plus a uuid, matching the
-- prefixed ids used elsewhere; Better Auth generates its own for organizations
-- it creates, and only reads them back, so a different shape here is safe.
INSERT INTO "organization" ("id", "name", "slug", "kind", "personal_user_id", "created_at", "updated_at")
SELECT
  'org_' || gen_random_uuid(),
  u."display_username",
  candidate.slug,
  'personal',
  u."id",
  now(),
  now()
FROM "user" u
CROSS JOIN LATERAL (
  -- The first free handle: the username itself, then -2, -3, … The bound is
  -- generous; with one row per user it is only reached if that many teams
  -- already hold the same stem.
  SELECT s.slug
  FROM (
    SELECT CASE WHEN n = 1 THEN u."username" ELSE u."username" || '-' || n END AS slug
    FROM generate_series(1, 1000) AS n
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM "organization" o WHERE o."slug" = s.slug
  )
  ORDER BY length(s.slug), s.slug
  LIMIT 1
) AS candidate
WHERE NOT EXISTS (
  -- Idempotent: a user who already has one is skipped, so a re-run is a no-op.
  SELECT 1 FROM "organization" o WHERE o."personal_user_id" = u."id"
);--> statement-breakpoint
-- Their sole membership, as owner. Separate statement so the ids above are
-- visible to it.
INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT
  'mbr_' || gen_random_uuid(),
  o."id",
  o."personal_user_id",
  'owner',
  now()
FROM "organization" o
WHERE o."kind" = 'personal'
  AND o."personal_user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "member" m
    WHERE m."organization_id" = o."id" AND m."user_id" = o."personal_user_id"
  );
