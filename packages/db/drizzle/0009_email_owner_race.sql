-- Make the single-owner check hold under concurrency.
--
-- 0007/0008 enforced the rule with a SELECT, which is correct in isolation and
-- not correct in parallel. Under READ COMMITTED — the default, and what this
-- database runs — a trigger cannot see another transaction's uncommitted rows.
-- Two sign-ins landing at once, one writing `user.email` and the other writing
-- `user_email.email` for the same address, each looked in the other's table,
-- each saw nothing, and both committed. The result was the split state these
-- triggers exist to forbid, reached with both triggers installed and firing.
--
-- A unique index cannot fix it because the rule spans two tables. What closes
-- it is making the two transactions take turns: an advisory lock keyed by the
-- address makes the second block until the first commits, at which point its
-- SELECT does see the committed row and raises as it should.
--
-- The lock is transaction-scoped (`pg_advisory_xact_lock`), so it is released
-- on commit or rollback with no unlock to forget. It is keyed on the
-- lowercased address rather than the row, because the address is what is being
-- contended — two different rows claiming one address is exactly the case.
-- hashtext gives the bigint the advisory API needs; a collision costs only
-- that two unrelated addresses serialize briefly, never a missed conflict,
-- because the SELECT below still does the real checking.
--
-- Deliberately not SERIALIZABLE isolation: it would also close this, but it
-- changes the contract for every transaction in the application and pushes
-- retry handling onto callers who have no idea this rule exists.
CREATE OR REPLACE FUNCTION assert_email_single_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  conflicting_user text;
BEGIN
  -- Serialize every writer touching this address, before looking.
  PERFORM pg_advisory_xact_lock(hashtext(lower(NEW.email)));

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
