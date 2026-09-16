-- Close two gaps in the 0007 trigger. Both were reachable; both are tested.
--
-- 1. Reassignment without touching the address.
--    0007 fired on `UPDATE OF email`, so moving a `user_email` row to another
--    user — `UPDATE user_email SET user_id = ...` — changed the owner without
--    the trigger ever running, landing in exactly the split state 0007 exists
--    to forbid. The column list now covers `user_id` too. A plain `UPDATE`
--    with no column list would be simpler but fires on every write to these
--    tables, including the token and timestamp churn of ordinary sign-ins.
--
-- 2. Case.
--    The comparison was `=`, so `alice@test` and `ALICE@test` read as two
--    different addresses and both could be held. The application lowercases on
--    the way in, which is precisely why the database must not assume it did:
--    a backstop that trusts the caller it is backstopping is not a backstop.
--    `lower()` on both sides makes the check independent of that.
--
-- Deliberately not a citext column or a functional unique index: neither can
-- span two tables, which is the whole reason this is a trigger.
CREATE OR REPLACE FUNCTION assert_email_single_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  conflicting_user text;
BEGIN
  IF TG_TABLE_NAME = 'user' THEN
    SELECT ue.user_id INTO conflicting_user
      FROM user_email ue
     WHERE lower(ue.email) = lower(NEW.email)
       AND ue.user_id <> NEW.id
     LIMIT 1;
  ELSE
    SELECT u.id INTO conflicting_user
      FROM "user" u
     WHERE lower(u.email) = lower(NEW.email)
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
DROP TRIGGER IF EXISTS user_email_rows_single_owner ON user_email;
--> statement-breakpoint
CREATE TRIGGER user_email_rows_single_owner
  AFTER INSERT OR UPDATE OF email, user_id ON user_email
  FOR EACH ROW EXECUTE FUNCTION assert_email_single_owner();
