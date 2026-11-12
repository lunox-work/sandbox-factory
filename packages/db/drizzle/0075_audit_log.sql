CREATE TABLE "audit_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"via" text NOT NULL,
	"credential_id" text NOT NULL,
	"client" text,
	"user_id" text,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"resource_id" text,
	"status" integer NOT NULL,
	"request_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_entry_via_check" CHECK ("audit_entry"."via" in ('session', 'token', 'oauth', 'device'))
);
--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entry_organization_at_idx" ON "audit_entry" USING btree ("organization_id","at","id");--> statement-breakpoint
CREATE INDEX "audit_entry_at_idx" ON "audit_entry" USING btree ("at");