CREATE TABLE "bounty_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"jira_issue_id" text NOT NULL,
	"spec_hash" text NOT NULL,
	"spec_hash_version" integer DEFAULT 1 NOT NULL,
	"rate_card" jsonb NOT NULL,
	"model_complexity" text NOT NULL,
	"model_confidence" text NOT NULL,
	"model_rationale" text NOT NULL,
	"unsized_reason" text,
	"input_truncated" boolean DEFAULT false NOT NULL,
	"actual_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"complexity" text NOT NULL,
	"sized_by" text DEFAULT 'model' NOT NULL,
	"resized_by" text,
	"resized_at" timestamp with time zone,
	"amount_minor" bigint,
	"currency" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"replaces_proposal_id" text,
	"decision_delivery_policy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_proposal_model_complexity_check" CHECK ("bounty_proposal"."model_complexity" in ('S', 'M', 'L', 'XL', 'unsized')),
	CONSTRAINT "bounty_proposal_complexity_check" CHECK ("bounty_proposal"."complexity" in ('S', 'M', 'L', 'XL', 'unsized')),
	CONSTRAINT "bounty_proposal_confidence_check" CHECK ("bounty_proposal"."model_confidence" in ('low', 'medium', 'high')),
	CONSTRAINT "bounty_proposal_status_check" CHECK ("bounty_proposal"."status" in ('proposed', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "bounty_proposal_sized_by_check" CHECK ("bounty_proposal"."sized_by" in ('model', 'reviewer')),
	CONSTRAINT "bounty_proposal_delivery_policy_check" CHECK ("bounty_proposal"."decision_delivery_policy" IS NULL OR "bounty_proposal"."decision_delivery_policy" in ('off', 'requested')),
	CONSTRAINT "bounty_proposal_revision_check" CHECK ("bounty_proposal"."revision" > 0),
	CONSTRAINT "bounty_proposal_hash_check" CHECK (length("bounty_proposal"."spec_hash") = 64 AND "bounty_proposal"."spec_hash_version" > 0),
	CONSTRAINT "bounty_proposal_rationale_check" CHECK (length("bounty_proposal"."model_rationale") between 1 and 500),
	CONSTRAINT "bounty_proposal_money_check" CHECK (("bounty_proposal"."complexity" = 'unsized' AND "bounty_proposal"."amount_minor" IS NULL AND "bounty_proposal"."currency" IS NULL) OR ("bounty_proposal"."complexity" <> 'unsized' AND "bounty_proposal"."amount_minor" > 0 AND "bounty_proposal"."amount_minor" <= 9007199254740991 AND "bounty_proposal"."currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "bounty_proposal_approved_sized_check" CHECK ("bounty_proposal"."status" <> 'approved' OR ("bounty_proposal"."complexity" <> 'unsized' AND NOT "bounty_proposal"."input_truncated"))
);
--> statement-breakpoint
CREATE TABLE "bounty_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"board_id" text NOT NULL,
	"started_by" text,
	"kind" text DEFAULT 'backlog' NOT NULL,
	"source_proposal_id" text,
	"source_revision" integer,
	"request_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"selection" jsonb NOT NULL,
	"rate_card" jsonb NOT NULL,
	"requested_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates_scanned" integer DEFAULT 0 NOT NULL,
	"skipped_live" integer DEFAULT 0 NOT NULL,
	"scan_limit_reached" boolean DEFAULT false NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"fatal_error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_run_organization_request_unique" UNIQUE("organization_id","request_id"),
	CONSTRAINT "bounty_run_kind_check" CHECK ("bounty_run"."kind" in ('backlog', 'reprice')),
	CONSTRAINT "bounty_run_status_check" CHECK ("bounty_run"."status" in ('queued', 'running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "bounty_run_source_check" CHECK (("bounty_run"."kind" = 'backlog' AND "bounty_run"."source_proposal_id" IS NULL AND "bounty_run"."source_revision" IS NULL) OR ("bounty_run"."kind" = 'reprice' AND "bounty_run"."source_proposal_id" IS NOT NULL AND "bounty_run"."source_revision" > 0))
);
--> statement-breakpoint
CREATE TABLE "rate_card" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"s_minor" bigint NOT NULL,
	"m_minor" bigint NOT NULL,
	"l_minor" bigint NOT NULL,
	"xl_minor" bigint NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_card_currency_check" CHECK ("rate_card"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "rate_card_amounts_check" CHECK ("rate_card"."s_minor" > 0 AND "rate_card"."s_minor" <= "rate_card"."m_minor" AND "rate_card"."m_minor" <= "rate_card"."l_minor" AND "rate_card"."l_minor" <= "rate_card"."xl_minor" AND "rate_card"."xl_minor" <= 9007199254740991),
	CONSTRAINT "rate_card_revision_check" CHECK ("rate_card"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_run_id_bounty_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bounty_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_jira_issue_id_jira_issue_id_fk" FOREIGN KEY ("jira_issue_id") REFERENCES "public"."jira_issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_resized_by_user_id_fk" FOREIGN KEY ("resized_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_replaces_proposal_id_fkey" FOREIGN KEY ("replaces_proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_board_id_jira_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_proposal_live_unique" ON "bounty_proposal" USING btree ("jira_issue_id") WHERE "bounty_proposal"."status" in ('proposed', 'approved');--> statement-breakpoint
CREATE INDEX "bounty_proposal_organization_id_idx" ON "bounty_proposal" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bounty_proposal_run_id_idx" ON "bounty_proposal" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_board_active_unique" ON "bounty_run" USING btree ("board_id") WHERE "bounty_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "bounty_run_organization_id_idx" ON "bounty_run" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bounty_run_board_created_idx" ON "bounty_run" USING btree ("board_id","created_at");