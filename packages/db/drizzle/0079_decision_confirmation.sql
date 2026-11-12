CREATE TABLE "decision_confirmation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"spec_revision" integer NOT NULL,
	"decisions_sha256" text NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_confirmation_proposal_revision_unique" UNIQUE("proposal_id","spec_revision"),
	CONSTRAINT "decision_confirmation_sha256_check" CHECK (length("decision_confirmation"."decisions_sha256") = 64 AND "decision_confirmation"."spec_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "decision_confirmation" ADD CONSTRAINT "decision_confirmation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_confirmation" ADD CONSTRAINT "decision_confirmation_proposal_id_bounty_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_confirmation" ADD CONSTRAINT "decision_confirmation_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_confirmation_organization_id_idx" ON "decision_confirmation" USING btree ("organization_id");