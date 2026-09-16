-- Close the case hole *within* each table.
--
-- 0008 made the cross-table comparison case-insensitive and stopped there,
-- which left half the rule byte-comparing. The trigger only ever looks at the
-- *other* table: a `user_email` row is checked against `"user"`, never against
-- `user_email`. Within one table the only thing standing between two users and
-- one address is the plain `unique` constraint on the column, and that is
-- byte-exact.
--
-- So this was accepted, with 0007-0009 installed and firing:
--
--   insert into user_email ... values ('e1', 'ua', 'mixed@example.test', ...);
--   insert into user_email ... values ('e2', 'ub', 'MIXED@Example.TEST', ...);
--
-- Two users, one address, differing only in case — exactly the state the
-- triggers exist to forbid, reached by the path they do not watch. The same
-- applied to `"user".email`, which is worse: that is two separate accounts on
-- one address, each able to sign in.
--
-- Fixed with functional unique indexes rather than by widening the trigger.
-- Within a single table uniqueness is expressible as an index, and an index is
-- the better tool here: it is enforced by the storage layer rather than by a
-- row-level function, it cannot be outrun by concurrent inserts the way a
-- SELECT-based check can (which is the whole subject of 0009), and it needs no
-- advisory lock to be correct. The trigger remains for the cross-table half,
-- which no index can express.
--
-- The existing byte-exact constraints are dropped: a case-insensitive index is
-- strictly stronger, so keeping both would only mean two error messages for
-- the same violation.
--
-- Not citext: it is an extension, so it needs to be installed in every
-- environment including CI, and it changes the column's type and comparison
-- semantics everywhere rather than stating the one rule actually wanted.

-- Pre-existing violations would make these index builds fail, which is the
-- correct outcome — the alternative is silently keeping rows the rule forbids.
-- 0010 reports them first so a failure here is diagnosable rather than a bare
-- "could not create unique index".

ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_email_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_email_lower_unique
  ON "user" (lower(email));
--> statement-breakpoint
ALTER TABLE user_email DROP CONSTRAINT IF EXISTS user_email_email_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_email_email_lower_unique
  ON user_email (lower(email));
