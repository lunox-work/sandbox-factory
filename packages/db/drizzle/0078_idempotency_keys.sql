CREATE TABLE "idempotency_key" (
	"organization_id" text NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"body_enc" text,
	"key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_organization_id_route_key_pk" PRIMARY KEY("organization_id","route","key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_key_expires_idx" ON "idempotency_key" USING btree ("expires_at");