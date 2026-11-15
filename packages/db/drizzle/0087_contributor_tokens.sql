CREATE TABLE "contributor_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributor_token_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "audit_entry" DROP CONSTRAINT "audit_entry_via_check";--> statement-breakpoint
ALTER TABLE "contributor_token" ADD CONSTRAINT "contributor_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contributor_token_user_created_idx" ON "contributor_token" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_via_check" CHECK ("audit_entry"."via" in ('session', 'token', 'oauth', 'device', 'contributor'));