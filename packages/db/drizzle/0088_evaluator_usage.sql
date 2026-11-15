CREATE TABLE "evaluator_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"seconds" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluator_usage_seconds_check" CHECK ("evaluator_usage"."seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grading_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"assignment_id" text,
	"run_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluator_usage" ADD CONSTRAINT "evaluator_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_attempt" ADD CONSTRAINT "grading_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluator_usage_organization_at_idx" ON "evaluator_usage" USING btree ("organization_id","at");--> statement-breakpoint
CREATE INDEX "grading_attempt_organization_at_idx" ON "grading_attempt" USING btree ("organization_id","at");--> statement-breakpoint
CREATE INDEX "grading_attempt_assignment_at_idx" ON "grading_attempt" USING btree ("assignment_id","at");