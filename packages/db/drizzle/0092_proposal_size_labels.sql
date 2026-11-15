CREATE TABLE "proposal_size_label" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_revision" integer NOT NULL,
	"spec_revision" integer,
	"model_complexity" text NOT NULL,
	"model_confidence" text NOT NULL,
	"rubric_complexity" text,
	"rubric" jsonb,
	"from_complexity" text NOT NULL,
	"from_sized_by" text NOT NULL,
	"from_amount_minor" bigint,
	"complexity" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"resized_by" text,
	"resized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_size_label_from_sized_by_check" CHECK ("proposal_size_label"."from_sized_by" in ('model', 'rubric', 'reviewer')),
	CONSTRAINT "proposal_size_label_revision_check" CHECK ("proposal_size_label"."proposal_revision" > 0 AND ("proposal_size_label"."spec_revision" IS NULL OR "proposal_size_label"."spec_revision" > 0))
);
--> statement-breakpoint
ALTER TABLE "proposal_size_label" ADD CONSTRAINT "proposal_size_label_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_size_label" ADD CONSTRAINT "proposal_size_label_proposal_id_bounty_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_size_label" ADD CONSTRAINT "proposal_size_label_resized_by_user_id_fk" FOREIGN KEY ("resized_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_size_label_organization_id_idx" ON "proposal_size_label" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "proposal_size_label_proposal_id_idx" ON "proposal_size_label" USING btree ("proposal_id");