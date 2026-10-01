-- A person's GitHub grant for an organization lives exactly as long as their
-- membership of it.
--
-- `github_grant` holds a user-to-server token, and the refresh token GitHub
-- keeps valid for six months, per (organization, user). It is used only
-- behind the membership guard, so a former member can no longer spend it —
-- but nothing removed it either, so it stayed at rest with no purpose, and a
-- person invited back was silently handed the old one.
--
-- A trigger rather than an application hook, because membership ends along
-- two paths and the organization plugin runs hooks on only one: an admin's
-- `remove-member` calls `afterRemoveMember`, while a member's own
-- `organization/leave` deletes the row directly. The database sees both.
--
-- Deleting the organization or the user already cascades from the foreign
-- keys; this covers the membership ending while both remain.

CREATE OR REPLACE FUNCTION drop_github_grant_with_member() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- The plugin keeps one row per person and organization, but a second one
  -- must not lose its grant to the first's removal.
  IF NOT EXISTS (
    SELECT 1 FROM member m
     WHERE m.organization_id = OLD.organization_id
       AND m.user_id = OLD.user_id
  ) THEN
    DELETE FROM github_grant g
     WHERE g.organization_id = OLD.organization_id
       AND g.user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_drops_github_grant
  AFTER DELETE ON member
  FOR EACH ROW EXECUTE FUNCTION drop_github_grant_with_member();
--> statement-breakpoint
-- Grants left behind by memberships that ended before this existed.
DELETE FROM github_grant g
 WHERE NOT EXISTS (
   SELECT 1 FROM member m
    WHERE m.organization_id = g.organization_id
      AND m.user_id = g.user_id
 );
