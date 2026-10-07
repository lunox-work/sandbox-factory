ALTER TYPE severity ADD VALUE 'medium' BEFORE 'high';
ALTER TABLE audit_log ADD COLUMN kind text;
ALTER TABLE audit_log RENAME COLUMN detail TO payload;
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_unique" UNIQUE ("kind", "actor");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
