-- One handle namespace for users and organizations, enforced by the database.
--
-- 0029 created `handle`, whose primary key is the handle itself. This fills it
-- from the rows that exist and installs the triggers that keep it filled.
--
-- The rule was documented before it was enforced. `user.username` and
-- `organization.slug` were each unique, but a username change checked only
-- other usernames and a team rename checked only other organizations, so a
-- person and a team could hold the same handle. And a personal organization's
-- handle was copied from its owner's username once, at signup, and could then
-- be edited on its own — two handles for one person, free to drift apart.
--
-- After this:
--   * every username and every team handle is a row in `handle`, so the
--     primary key refuses a second holder, whoever writes and however many
--     write at once;
--   * a personal organization's handle *is* its owner's username. It claims
--     nothing itself, follows every username change, and cannot be set to
--     anything else.
--
-- Existing conflicts are settled rather than refused, so the migration cannot
-- block a deploy on data the old rules let in:
--   * a user keeps their username;
--   * a team whose handle is a username, or (in a different case) an older
--     team's, is renamed to the first free `-2`, `-3`, … — the same scheme
--     0015 used for personal organizations;
--   * a personal organization is renamed to its owner's username.
-- Users yield to nobody: a username is how somebody signs in and is invited,
-- where a team handle is a URL.
--
-- Triggers rather than the stores, for the reason 0007 gives: Better Auth
-- writes `user` and `organization` itself, through no code of ours.

-- 1. Personal organizations that do not already carry their owner's username
--    step aside to a placeholder no handle can equal (`~` is outside the
--    handle alphabet). Otherwise the team renames below could collide with a
--    personal handle that is about to move anyway, and a personal one could
--    collide with another that has not moved yet.
UPDATE organization o
   SET slug = '~' || o.id
  FROM "user" u
 WHERE o.personal_user_id = u.id
   AND o.kind = 'personal'
   AND o.slug <> lower(u.username);
--> statement-breakpoint

-- 2. Every user claims their username.
INSERT INTO handle (handle, user_id)
SELECT lower(u.username), u.id
  FROM "user" u;
--> statement-breakpoint

-- 3. Teams claim theirs, oldest first, so of two that collide the newer one is
--    the one renamed. The suffix is fitted inside the 30-character limit in
--    `packages/core/src/handle.ts`.
DO $$
DECLARE
  team record;
  candidate text;
  n integer;
BEGIN
  FOR team IN
    SELECT o.id, lower(o.slug) AS slug
      FROM organization o
     WHERE o.kind = 'team'
     ORDER BY o.created_at, o.id
  LOOP
    candidate := team.slug;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM handle h WHERE h.handle = candidate)
       OR EXISTS (
            SELECT 1
              FROM organization o
             WHERE lower(o.slug) = candidate
               AND o.id <> team.id
          )
    LOOP
      n := n + 1;
      candidate := left(team.slug, 30 - length('-' || n)) || '-' || n;
    END LOOP;

    UPDATE organization
       SET slug = candidate, updated_at = now()
     WHERE id = team.id
       AND slug <> candidate;

    INSERT INTO handle (handle, organization_id) VALUES (candidate, team.id);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- 4. Personal organizations take their owner's username. Every username is
--    claimed and no team holds one any more, so nothing is in the way.
UPDATE organization o
   SET slug = lower(u.username), updated_at = now()
  FROM "user" u
 WHERE o.personal_user_id = u.id
   AND o.slug = '~' || o.id;
--> statement-breakpoint

-- 5. A username claims its handle, and carries its personal organization with
--    it.
--
--    Upsert by holder: an update renames the user's row, so the old handle is
--    released in the same statement that takes the new one. A collision is
--    the primary key's unique_violation, re-raised with a message that says
--    what happened rather than naming an index.
CREATE OR REPLACE FUNCTION claim_user_handle() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.username = OLD.username THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE handle SET handle = lower(NEW.username) WHERE user_id = NEW.id;
    IF NOT FOUND THEN
      INSERT INTO handle (handle, user_id) VALUES (lower(NEW.username), NEW.id);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'handle % is already taken', lower(NEW.username)
      USING ERRCODE = 'unique_violation';
  END;

  -- Fires `organization_claims_handle`, which checks the result.
  UPDATE organization
     SET slug = lower(NEW.username), updated_at = now()
   WHERE personal_user_id = NEW.id
     AND slug <> lower(NEW.username);

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_claims_handle
  AFTER INSERT OR UPDATE OF username ON "user"
  FOR EACH ROW EXECUTE FUNCTION claim_user_handle();
--> statement-breakpoint

-- 6. A team claims its handle; a personal organization must carry its owner's.
--
--    `kind` and `personal_user_id` are in the column list as well as `slug`:
--    either can change what the row is owed, and 0008 is the record of what a
--    trigger missing a column let through.
CREATE OR REPLACE FUNCTION claim_organization_handle() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  owner_handle text;
BEGIN
  IF NEW.kind = 'personal' THEN
    SELECT lower(u.username) INTO owner_handle
      FROM "user" u
     WHERE u.id = NEW.personal_user_id;

    IF owner_handle IS NULL OR NEW.slug <> owner_handle THEN
      RAISE EXCEPTION
        'personal organization % must carry its owner''s username (%), not %',
        NEW.id, owner_handle, NEW.slug
        USING ERRCODE = 'check_violation';
    END IF;

    -- A team turned personal gives its old claim back.
    DELETE FROM handle WHERE organization_id = NEW.id;
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE handle SET handle = lower(NEW.slug) WHERE organization_id = NEW.id;
    IF NOT FOUND THEN
      INSERT INTO handle (handle, organization_id)
      VALUES (lower(NEW.slug), NEW.id);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'handle % is already taken', lower(NEW.slug)
      USING ERRCODE = 'unique_violation';
  END;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_claims_handle
  AFTER INSERT OR UPDATE OF slug, kind, personal_user_id ON organization
  FOR EACH ROW EXECUTE FUNCTION claim_organization_handle();
