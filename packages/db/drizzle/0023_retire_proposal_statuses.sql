-- A proposal is proposed or approved. Rows in the two retired statuses are
-- history nobody can act on, and the constraint that follows would refuse
-- them; nothing in any environment holds one, so this is belt and braces.
DELETE FROM "bounty_proposal" WHERE "status" IN ('rejected', 'superseded');
--> statement-breakpoint
DELETE FROM "bounty_writeback" WHERE "kind" IN ('rejected', 'superseded');
