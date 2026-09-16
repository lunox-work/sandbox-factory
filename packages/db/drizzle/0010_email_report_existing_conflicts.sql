-- Report addresses already held by more than one account.
--
-- 0007 states that the split state "is one the application actually reached",
-- and none of 0007-0009 look for rows already in it. The triggers are
-- AFTER INSERT OR UPDATE, so an existing bad pair is never examined: it sits
-- there until something happens to write one of the two rows, which may be
-- never. A rule enforced only against future writes says nothing about the
-- data already stored.
--
-- This raises rather than repairs. Picking a winner is not a decision a
-- migration can make: the two rows are two people's accounts, possibly both
-- signed into, with todos and linked providers behind them. Merging them is a
-- product decision and deleting one loses data, so the honest move is to stop
-- and name them.
--
-- It runs *before* 0011's indexes in migration order for a practical reason:
-- a unique index build on conflicting data fails with `could not create unique
-- index` and a single duplicated value, which is a poor way to learn you have
-- a data problem. This lists every conflict, on both tables, in one message.
--
-- Deliberately not a permanent object. There is no function or trigger left
-- behind; it is a one-off assertion that runs once and leaves nothing to
-- maintain, because the ongoing enforcement is 0011's indexes and 0007's
-- triggers.
DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(detail, E'\n') INTO conflicts FROM (
    -- Same address, different accounts, within `user`.
    SELECT '  ' || lower(u.email) || ' held by users: ' ||
           string_agg(u.id, ', ' ORDER BY u.id) AS detail
      FROM "user" u
     GROUP BY lower(u.email)
    HAVING count(*) > 1

    UNION ALL

    -- Same, within `user_email`.
    SELECT '  ' || lower(ue.email) || ' proven by users: ' ||
           string_agg(DISTINCT ue.user_id, ', ') AS detail
      FROM user_email ue
     GROUP BY lower(ue.email)
    HAVING count(DISTINCT ue.user_id) > 1

    UNION ALL

    -- The cross-table split: one account carries it as primary while a
    -- different account has proven it. This is the case 0007 was written for.
    SELECT '  ' || lower(u.email) || ' is user ' || u.id ||
           '''s primary but proven by user ' || ue.user_id AS detail
      FROM "user" u
      JOIN user_email ue
        ON lower(ue.email) = lower(u.email)
       AND ue.user_id <> u.id
  ) found;

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION E'email addresses held by more than one account:\n%\n\nResolve these before migrating. Each line is two accounts sharing one address; choosing which survives is a product decision, so this migration will not guess.', conflicts;
  END IF;
END $$;
