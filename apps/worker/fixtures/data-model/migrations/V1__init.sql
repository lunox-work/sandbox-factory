-- The first migration.
CREATE TYPE "public"."severity" AS ENUM ('low', 'high');

CREATE TABLE "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" varchar(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor integer REFERENCES users (id) ON DELETE SET NULL,
  severity severity NOT NULL DEFAULT 'low',
  detail jsonb DEFAULT '{}'::jsonb,
  at timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO audit_log (detail) VALUES ('{}');
