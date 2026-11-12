CREATE TABLE "submission_merge" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"pull_request_url" text NOT NULL,
	"opened_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_merge_submission_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
ALTER TABLE "submission_merge" ADD CONSTRAINT "submission_merge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD CONSTRAINT "submission_merge_submission_id_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD CONSTRAINT "submission_merge_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_merge_organization_id_idx" ON "submission_merge" USING btree ("organization_id");