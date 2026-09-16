-- Give every todo an owner.
--
-- Until now `todos` had no `user_id`: the routes sat behind a session but the
-- table did not know who anything belonged to, so every signed-in user was
-- served the whole table. This column is what makes a todo private.
--
-- The delete below is deliberate and is the only honest option. Adding a
-- `not null` column to a table with rows requires a value for each, and there
-- is none to give: rows written before this migration have no owner recorded
-- anywhere, so there is nobody to assign them to. They predate authentication
-- entirely — they were written by whoever could reach the API. Assigning them
-- to an arbitrary user would hand one person another's data, which is the bug
-- this migration exists to close.
--
-- In practice this clears local development data only; the feature has not
-- shipped with real users. If that ever stops being true, replace this with a
-- backfill that assigns rows to a known owner before the column is tightened.
DELETE FROM "todos";
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todos_user_id_created_at_idx" ON "todos" USING btree ("user_id","created_at" desc);
