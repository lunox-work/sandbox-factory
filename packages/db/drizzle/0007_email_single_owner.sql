-- One address, one owner — enforced by the database rather than by a caller.
--
-- An address can live in two places: `user.email` (the primary, which is what
-- Better Auth itself reads) and `user_email.email` (every address a provider
-- has proven). Both columns are already unique, and that is not sufficient:
-- neither constraint can see the other, so an address free in one table can be
-- taken in the other. Postgres cannot express "unique across the union of two
-- columns" as a constraint, which is why this is a trigger.
--
-- The state this makes unreachable is one the application actually reached:
-- user A holding an address as `user.email` while user B owns the same address
-- in `user_email`. Each table was internally consistent and the pair was not.
--
-- `record()` in emails.ts already refuses this, and that guard is real but sits
-- in one function. Better Auth's own user-creation path does not go through it,
-- which is exactly how the bad rows were written. Enforcing it here covers
-- every writer — the library, our code, a migration, a manual psql session, and
-- whatever gets added later without reading emails.ts.
--
-- Not a BEFORE trigger: these raise rather than rewrite the row, so there is
-- nothing to return, and AFTER keeps them out of the business of mutating
-- what was written. Sign-in creates the user and account in one transaction,
-- so a raise here rolls back both rather than leaving a half-built account.
CREATE OR REPLACE FUNCTION assert_email_single_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  conflicting_user text;
BEGIN
  IF TG_TABLE_NAME = 'user' THEN
    -- The address is being claimed as a primary; refuse if a *different*
    -- user has already proven it.
    SELECT ue.user_id INTO conflicting_user
      FROM user_email ue
     WHERE ue.email = NEW.email
       AND ue.user_id <> NEW.id
     LIMIT 1;
  ELSE
    -- A provider is proving an address; refuse if it is already some other
    -- user's primary.
    SELECT u.id INTO conflicting_user
      FROM "user" u
     WHERE u.email = NEW.email
       AND u.id <> NEW.user_id
     LIMIT 1;
  END IF;

  IF conflicting_user IS NOT NULL THEN
    RAISE EXCEPTION
      'email % is already held by user %', NEW.email, conflicting_user
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_email_single_owner
  AFTER INSERT OR UPDATE OF email ON "user"
  FOR EACH ROW EXECUTE FUNCTION assert_email_single_owner();
--> statement-breakpoint
CREATE TRIGGER user_email_rows_single_owner
  AFTER INSERT OR UPDATE OF email ON user_email
  FOR EACH ROW EXECUTE FUNCTION assert_email_single_owner();
