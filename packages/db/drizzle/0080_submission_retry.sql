ALTER TABLE "submission" ADD COLUMN "retry_of" text;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_retry_of_submission_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."submission"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_retry_of_unique" UNIQUE("retry_of");