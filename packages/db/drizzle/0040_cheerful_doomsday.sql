CREATE TABLE "analysis_run" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"tool" text NOT NULL,
	"tool_version" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"requested_by" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	"log_key" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_run_cache_unique" UNIQUE("snapshot_id","tool","tool_version","params_hash")
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_run_path_unique" UNIQUE("run_id","path")
);
--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_snapshot_id_repo_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_analysis_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_run_status_created_at_idx" ON "analysis_run" USING btree ("status","created_at");