-- Backfill: a bounty has no issue type, priority or labels any more, so the
-- fingerprint a proposal is priced against (`bountySpecHash`) no longer
-- hashes the type. Version 2 hashes the normalized title and description;
-- version 1 hashed the issue type as a third member.
--
-- Hand-written because drizzle-kit generates schema, not data, and run
-- before the columns go, while the type can still be read. A proposal or a
-- spec revision whose version 1 hash is its bounty's as the bounty stands
-- now moves to version 2, and so stays current. One that does not match was
-- already stale, and is left on version 1, which reads as stale too.
--
-- Each hash is computed as `packages/core/src/bounty.ts` computes it: every
-- field with CRLF and CR made LF, JavaScript's whitespace cut from the end
-- of each line and from both ends of the whole, then the fields as a JSON
-- array, its UTF-8 bytes through SHA-256, in lowercase hex. A row moves only
-- when the version 1 hash computed here reproduces the stored one exactly,
-- so text normalized here differently from there cannot be given a wrong
-- version 2 hash: its proposal is left stale instead.
CREATE TEMPORARY TABLE "bounty_spec_hash" AS
WITH "normalized" AS (
  SELECT "id",
    regexp_replace(regexp_replace(regexp_replace("title", '\r\n?', E'\n', 'g'),
      '[\t\v\f    -     　﻿]+$', '', 'gn'),
      '^[\t\n\v\f    -     　﻿]+|[\t\n\v\f    -     　﻿]+$', '', 'g') AS "title",
    regexp_replace(regexp_replace(regexp_replace("description", '\r\n?', E'\n', 'g'),
      '[\t\v\f    -     　﻿]+$', '', 'gn'),
      '^[\t\n\v\f    -     　﻿]+|[\t\n\v\f    -     　﻿]+$', '', 'g') AS "description",
    regexp_replace(regexp_replace(regexp_replace("issue_type", '\r\n?', E'\n', 'g'),
      '[\t\v\f    -     　﻿]+$', '', 'gn'),
      '^[\t\n\v\f    -     　﻿]+|[\t\n\v\f    -     　﻿]+$', '', 'g') AS "issue_type"
  FROM "bounty"
)
SELECT "id",
  encode(sha256(convert_to(array_to_json(ARRAY["title", "description", "issue_type"])::text, 'UTF8')), 'hex') AS "v1",
  encode(sha256(convert_to(array_to_json(ARRAY["title", "description"])::text, 'UTF8')), 'hex') AS "v2"
FROM "normalized";--> statement-breakpoint
UPDATE "bounty_proposal" p
SET "spec_hash" = h."v2", "spec_hash_version" = 2
FROM "bounty_spec_hash" h
WHERE h."id" = p."bounty_id"
  AND p."spec_hash_version" = 1
  AND p."spec_hash" = h."v1";--> statement-breakpoint
UPDATE "bounty_spec" s
SET "spec_hash" = h."v2", "spec_hash_version" = 2
FROM "bounty_proposal" p
JOIN "bounty_spec_hash" h ON h."id" = p."bounty_id"
WHERE s."proposal_id" = p."id"
  AND s."spec_hash_version" = 1
  AND s."spec_hash" = h."v1";--> statement-breakpoint
DROP TABLE "bounty_spec_hash";--> statement-breakpoint
ALTER TABLE "bounty" DROP COLUMN "issue_type";--> statement-breakpoint
ALTER TABLE "bounty" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "bounty" DROP COLUMN "labels";--> statement-breakpoint
ALTER TABLE "bounty_profile" DROP COLUMN "bounty";
