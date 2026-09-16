-- Backfill handles for users who predate the column, then tighten it.
--
-- `0002` added `username` and `display_username` as nullable with no default,
-- because a `not null` column cannot be added to a table that already has
-- rows without a value for each. Every user row written before that migration
-- therefore carries null in both, and the two `SET NOT NULL` statements below
-- fail outright on any such row.
--
-- On a fresh database the table is empty and these updates touch nothing, so
-- this is invisible in development. It is a deployment against existing users
-- that breaks — exactly the case where the failure is most expensive and the
-- least likely to have been rehearsed.
--
-- The handle is derived the same way `toHandleBase` in `emails.ts` derives it
-- for a new signup: the local part of the address, lowercased, with anything
-- outside `[a-z0-9_-]` folded to a hyphen and leading/trailing hyphens
-- trimmed. Kept in SQL rather than run as a script so the backfill and the
-- constraint that depends on it cannot be applied separately.
-- Two users can share a local part across different domains ("dana@a.com" and
-- "dana@b.com"), and a stem truncated to 30 characters collides more easily
-- still — so uniqueness has to be resolved in the same statement that assigns
-- the handle, not in a later pass. A second UPDATE would be too late: the
-- first one has already violated `user_username_unique` by then.
--
-- Duplicates are numbered oldest-first, and the oldest keeps the bare handle
-- (suffixes start at 2), matching what `suggest` does for a live collision:
-- dana, dana2, dana3.
UPDATE "user"
SET "username" = "candidate"."handle",
    "display_username" = "candidate"."handle"
FROM (
  SELECT
    "id",
    CASE
      WHEN "n" = 1 THEN "stem"
      -- Trim the stem, not the suffix, so the counter survives the 30-char cap
      -- and the result stays unique.
      ELSE left("stem", 30 - length("n"::text)) || "n"::text
    END AS "handle"
  FROM (
    SELECT
      "id",
      "stem",
      row_number() OVER (PARTITION BY "stem" ORDER BY "created_at", "id") AS "n"
    FROM (
      SELECT
        "id",
        "created_at",
        -- Pad a stem shorter than the 3-character minimum rather than emit an
        -- invalid handle: "jo@example.com" is a real address. A local part
        -- that is only punctuation reduces to empty and falls back to the id,
        -- which is unique by construction.
        CASE
          WHEN length("raw") >= 3 THEN "raw"
          WHEN length("raw") = 0 THEN 'user-' || left(md5("id"), 8)
          ELSE "raw" || '-user'
        END AS "stem"
      FROM (
        SELECT
          "id",
          "created_at",
          trim(
            BOTH '-' FROM
            left(regexp_replace(lower(split_part("email", '@', 1)), '[^a-z0-9_-]+', '-', 'g'), 30)
          ) AS "raw"
        FROM "user"
        WHERE "username" IS NULL
      ) AS "locals"
    ) AS "stems"
  ) AS "ranked"
) AS "candidate"
WHERE "user"."id" = "candidate"."id" AND "user"."username" IS NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "display_username" SET NOT NULL;
